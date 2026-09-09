// UI proxy: verifies a Cognito JWT, invokes the AgentGate AgentCore
// Runtime, and streams its SSE events back through the Function URL.
// The Function URL is AWS_IAM-authed; only CloudFront's OAC can reach it.

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import crypto from "node:crypto";

const client = new BedrockAgentCoreClient({ region: process.env.EVAL_REGION });

// clientId null: the pool's only client is ours; pinning it here would create
// a CloudFormation cycle (client -> distribution -> function URL -> this fn).
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID,
  tokenUse: "access",
  clientId: null,
});

function respond(responseStream, statusCode, body) {
  const meta = {
    statusCode,
    headers: { "Content-Type": "application/json" },
  };
  responseStream = awslambda.HttpResponseStream.from(responseStream, meta);
  responseStream.write(JSON.stringify(body));
  responseStream.end();
}

export const handler = awslambda.streamifyResponse(
  async (event, responseStream) => {
    const auth =
      event.headers?.["x-authorization"] ||
      event.headers?.["X-Authorization"] ||
      "";
    const token = auth.replace(/^Bearer\s+/i, "");
    try {
      await verifier.verify(token);
    } catch {
      respond(responseStream, 401, { error: "Unauthorized" });
      return;
    }

    let payload;
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body ?? "", "base64").toString()
        : event.body ?? "{}";
      payload = JSON.parse(raw);
    } catch {
      respond(responseStream, 400, { error: "Invalid JSON body" });
      return;
    }

    const meta = {
      statusCode: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    };
    responseStream = awslambda.HttpResponseStream.from(responseStream, meta);

    try {
      const resp = await client.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: process.env.EVAL_RUNTIME_ARN,
          runtimeSessionId: crypto.randomUUID().replaceAll("-", "") + "0",
          contentType: "application/json",
          accept: "text/event-stream",
          payload: JSON.stringify(payload),
        })
      );
      // resp.response is a stream of SSE bytes from the runtime; pipe as-is.
      for await (const chunk of resp.response) {
        responseStream.write(chunk);
      }
    } catch (err) {
      responseStream.write(
        `data: ${JSON.stringify({ event: "error", error: String(err) })}\n\n`
      );
    } finally {
      responseStream.end();
    }
  }
);
