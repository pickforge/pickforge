import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runTool } from "../context.js";

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
    (args) =>
      runTool(async () => {
        const kind = args.kind ?? "text";
        if (kind === "text" && SECRET_QUESTION_PATTERN.test(args.question)) {
          return { errors: [SECRET_GUIDANCE] };
        }
        if (server.server.getClientCapabilities()?.elicitation === undefined) {
          return { errors: [NO_ELICITATION_GUIDANCE] };
        }
        const message =
          args.context === undefined
            ? args.question
            : `${args.question}\n\nContext: ${args.context}`;
        const fieldName = kind === "confirm" ? "confirmed" : "answer";
        const requestedSchema: ElicitRequestFormParams["requestedSchema"] = {
          type: "object",
          properties: {
            [fieldName]:
              kind === "confirm"
                ? {
                    type: "boolean",
                    title: "Confirm",
                    description: args.question,
                  }
                : {
                    type: "string",
                    title: "Answer",
                    description: args.question,
                  },
          },
          required: [fieldName],
        };
        const result = await server.server.elicitInput({
          message,
          requestedSchema,
        });
        if (result.action === "accept") {
          const value =
            kind === "confirm"
              ? result.content?.confirmed
              : result.content?.answer;
          return { data: { action: "accept", value } };
        }
        if (result.action === "decline") {
          return {
            data: { action: "decline" },
            errors: [
              "The user declined to answer. Do not ask again through this " +
                "tool; continue without this input or ask in your " +
                "conversation.",
            ],
          };
        }
        return {
          data: { action: "cancel" },
          errors: [
            "The user dismissed the prompt without answering. Relay the " +
              "question in your conversation, or retry later.",
          ],
        };
      }),
  );
}
