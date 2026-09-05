import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type ElicitRequestFormParams,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { reportResult } from "../context.js";

const SECRET_QUESTION_PATTERN =
  /password|api[_ -]?key|token|secret|2fa|otp|credential/i;

const SECRET_GUIDANCE =
  "This looks like a request for a secret (password, API key, token, 2FA " +
  "code, or other credential). Never collect secrets through this tool. " +
  "Ask the user to run `pickforge-lab watch --control` to take temporary " +
  "supervised control of the desktop over a writable VNC session, enter " +
  "the secret themselves, and return control (or into the environment), " +
  'then confirm out-of-band with kind "confirm" (e.g. "I\'ve entered the ' +
  'password, continue?"). While control is held, agent desktop input and ' +
  "the DevTools relay fail closed with a busy error; call " +
  "`takeover_status` to check.";

const NO_ELICITATION_GUIDANCE =
  "This client does not support elicitation. Relay the question to the " +
  "user in your conversation and wait for their answer before continuing.";

const INVALID_ELICITATION_GUIDANCE =
  "The client returned an invalid elicitation response. Relay the question " +
  "in your conversation and wait for a valid answer before continuing.";

const INPUT_RESPONSE_KEY = "userInput";

function supportsElicitation(server: McpServer, context: ServerContext): boolean {
  const envelope = context.mcpReq.envelope as
    | Record<string, unknown>
    | undefined;
  const modernCapabilities = envelope?.[
    CLIENT_CAPABILITIES_META_KEY
  ] as ClientCapabilities | undefined;
  const capabilities =
    modernCapabilities ?? server.server.getClientCapabilities();
  return capabilities?.elicitation !== undefined;
}

function requestedSchema(
  kind: "text" | "confirm",
  question: string,
): ElicitRequestFormParams["requestedSchema"] {
  const fieldName = kind === "confirm" ? "confirmed" : "answer";
  return {
    type: "object",
    properties: {
      [fieldName]:
        kind === "confirm"
          ? { type: "boolean", title: "Confirm", description: question }
          : { type: "string", title: "Answer", description: question },
    },
    required: [fieldName],
  };
}

export function registerUserTools(server: McpServer): void {
  server.registerTool(
    "request_user_input",
    {
      title: "Ask the user",
      description:
        "Ask the human user a question and wait for the answer. Use this " +
        "when you are blocked on something only a human can provide: a " +
        "judgment call, a license acceptance, a click you cannot perform, " +
        "or confirmation that an out-of-band step is done. SECURITY: never " +
        "request passwords, API keys, or tokens through this tool — ask " +
        "the user to enter them directly through an explicit writable VNC " +
        "control session, or into the environment, then confirm with kind " +
        '"confirm".',
      inputSchema: {
        question: z
          .string()
          .min(1)
          .describe("The question to put to the user"),
        kind: z
          .enum(["text", "confirm"])
          .optional()
          .describe(
            'Answer kind: "text" for a free-form answer, "confirm" for a ' +
              'yes/no decision (default "text")',
          ),
        context: z
          .string()
          .min(1)
          .optional()
          .describe("Why this input is needed, shown alongside the question"),
      },
    },
    (args, context) => {
      const kind = args.kind ?? "text";
      if (kind === "text" && SECRET_QUESTION_PATTERN.test(args.question)) {
        return reportResult({ errors: [SECRET_GUIDANCE] });
      }
      const response = inputResponse(
        context.mcpReq.inputResponses,
        INPUT_RESPONSE_KEY,
      );
      if (response.kind === "missing") {
        if (!supportsElicitation(server, context)) {
          return reportResult({ errors: [NO_ELICITATION_GUIDANCE] });
        }
        const message =
          args.context === undefined
            ? args.question
            : `${args.question}\n\nContext: ${args.context}`;
        return inputRequired({
          inputRequests: {
            [INPUT_RESPONSE_KEY]: inputRequired.elicit({
              message,
              requestedSchema: requestedSchema(kind, args.question),
            }),
          },
        });
      }
      if (response.kind !== "elicit") {
        return reportResult({ errors: [INVALID_ELICITATION_GUIDANCE] });
      }
      if (response.action === "accept") {
        const value =
          kind === "confirm"
            ? response.content?.confirmed
            : response.content?.answer;
        const valid =
          kind === "confirm"
            ? typeof value === "boolean"
            : typeof value === "string";
        return valid
          ? reportResult({ data: { action: "accept", value } })
          : reportResult({ errors: [INVALID_ELICITATION_GUIDANCE] });
      }
      if (response.action === "decline") {
        return reportResult({
          data: { action: "decline" },
          errors: [
            "The user declined to answer. Do not ask again through this " +
              "tool; continue without this input or ask in your conversation.",
          ],
        });
      }
      return reportResult({
        data: { action: "cancel" },
        errors: [
          "The user dismissed the prompt without answering. Relay the " +
            "question in your conversation, or retry later.",
        ],
      });
    },
  );
}
