"""Failure diagnosis via strands_evals Detectors.

diagnose(): failure detection -> root cause analysis on a Session, condensed
to a JSON-friendly dict for reports/UI. Auto-triggered for low-scoring
sessions; also exposed as a manual action.
"""

import logging

from strands_evals.detectors import diagnose_session

logger = logging.getLogger("eval-anything")

LOW_SCORE_THRESHOLD = 0.7


def needs_diagnosis(results: dict | None, had_error: bool = False) -> bool:
    """Auto-trigger rule: any evaluator score below threshold, or a hard error."""
    if had_error:
        return True
    for r in (results or {}).values():
        score = r.get("score")
        if isinstance(score, (int, float)) and score < LOW_SCORE_THRESHOLD:
            return True
    return False


def diagnose(session, judge_model: str) -> dict | None:
    """Run detector pipeline on a Session; None when nothing was found."""
    import judgellm
    result = diagnose_session(session, model=judgellm.strands_model(judge_model))
    failures = [
        {"span_id": f.span_id, "category": f.category,
         "confidence": str(f.confidence), "evidence": str(f.evidence)[:300]}
        for f in (result.failures or [])
    ]
    root_causes = [
        {"location": r.location,
         # 根因本身那句话（RCAItem.root_cause_explanation）。此前只抄了「怎么修」
         # （fix_recommendation），于是界面能说修法却说不出为什么是它。
         "root_cause_explanation": str(r.root_cause_explanation)[:500],
         "causality": str(r.causality)[:300],
         "impact": str(r.propagation_impact)[:200],
         "fix_type": r.fix_type,
         "fix_recommendation": str(r.fix_recommendation)[:500]}
        for r in (result.root_causes or [])
    ]
    if not failures and not root_causes:
        # ran and found nothing: a meaningful verdict (low score is style/
        # design, not an execution failure) — keep it distinguishable from
        # "not diagnosed at all"
        return {"failures": [], "root_causes": [], "clean": True}
    return {"failures": failures, "root_causes": root_causes}
