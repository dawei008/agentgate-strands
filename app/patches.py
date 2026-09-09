"""Workarounds for strands-agents-evals bugs.

1. CloudWatchLogsParser drops inline span events: AgentCore runtime log records
   carry them under "events" on the span record itself, but parse() only
   associates events found as separate log records, and overwrites span_events
   at the end (strands-agents-evals 1.1.1). Without them, sessions map with
   empty prompts/responses and content evaluators judge blank conversations.

2. detect_otel_mapper mis-routes Strands-scoped dict spans: newer strands
   telemetry emits scope "strands.telemetry.tracer" with gen_ai.* ATTRIBUTES
   (no CloudWatch body events). The detector sees the Strands scope, skips
   GenericGenAISessionMapper (scope is "known"), and falls back to
   StrandsInMemorySessionMapper — which expects ReadableSpan OBJECTS and
   crashes on dicts with "'dict' object has no attribute 'attributes'".
   GenericGenAISessionMapper parses these sessions fine (verified against
   live tauairline traces: full prompts/responses/tools recovered).

Remove once fixed upstream.
"""

import logging

from strands_evals.mappers import cloudwatch_parser, utils as mapper_utils
from strands_evals.providers import cloudwatch_provider

logger = logging.getLogger("eval-anything")

_original_parse = cloudwatch_parser.CloudWatchLogsParser.parse


def _inline_events_by_span_id(raw_logs):
    out = {}
    for record in raw_logs:
        span_id = record.get("spanId") or record.get("span_id", "")
        inline = record.get("events")
        if not span_id or not isinstance(inline, list) or not inline:
            continue
        out[span_id] = [
            {
                "event_name": e.get("name", ""),
                "name": e.get("name", ""),
                "span_id": span_id,
                "trace_id": record.get("traceId") or record.get("trace_id", ""),
                "attributes": e.get("attributes", {}) or {},
                "body": e.get("body"),
                "timestamp": e.get("timeUnixNano", 0),
            }
            for e in inline
            if isinstance(e, dict)
        ]
    return out


# Most recent parse result, for metrics aggregation. Sessions are evaluated
# sequentially in main.py, so a module-level slot is safe here.
LAST_PARSED_SPANS: list[dict] = []


def _parse_with_inline_events(self):
    global LAST_PARSED_SPANS
    spans = _original_parse(self)
    inline = _inline_events_by_span_id(self.raw_logs)
    for span in spans:
        if not span.get("span_events") and span.get("span_id") in inline:
            span["span_events"] = inline[span["span_id"]]
    LAST_PARSED_SPANS = spans
    return spans


_original_detect = mapper_utils.detect_otel_mapper


def _detect_with_dict_guard(spans):
    """Never hand dict spans to StrandsInMemorySessionMapper.

    That mapper is written for in-memory ReadableSpan objects; every span
    coming through CloudWatchLogsParser is a plain dict. If the original
    detector falls back to it, re-route to GenericGenAISessionMapper when the
    spans carry gen_ai.* attributes (covers strands.telemetry.tracer scope
    with attribute-style telemetry), else CloudWatchSessionMapper.
    """
    from strands_evals.mappers.cloudwatch_session_mapper import CloudWatchSessionMapper
    from strands_evals.mappers.generic_gen_ai_session_mapper import GenericGenAISessionMapper
    from strands_evals.mappers.strands_in_memory_session_mapper import StrandsInMemorySessionMapper

    mapper = _original_detect(spans)
    if isinstance(mapper, StrandsInMemorySessionMapper) and spans and isinstance(spans[0], dict):
        if any("gen_ai.operation.name" in (s.get("attributes") or {}) for s in spans):
            logger.info("dict spans with gen_ai.* attrs: re-routing to GenericGenAISessionMapper")
            return GenericGenAISessionMapper()
        logger.info("dict spans without gen_ai attrs: re-routing to CloudWatchSessionMapper")
        return CloudWatchSessionMapper()
    return mapper


def apply():
    cloudwatch_parser.CloudWatchLogsParser.parse = _parse_with_inline_events
    mapper_utils.detect_otel_mapper = _detect_with_dict_guard
    # cloudwatch_provider 用 from-import 拿了自己的引用，必须同步替换
    cloudwatch_provider.detect_otel_mapper = _detect_with_dict_guard
    logger.info("applied CloudWatchLogsParser inline-events + mapper dict-guard patches")
