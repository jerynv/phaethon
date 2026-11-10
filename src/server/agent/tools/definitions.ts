import type { ToolDef } from "../../providers/types.ts";

/**
 * The tools offered to the model, in a fixed order (the order is part of the
 * cached prompt prefix). The first eight are the old core's, unchanged.
 * Eager input streaming skips server-side validation, so `parseCall` in
 * `calls.ts` is the only input check.
 */

const PATH_LOCAL_OR_OTHER =
  'Path relative to the space root, e.g. "notes/today.md", or "@<space>/<path>" for a granted part of another space, e.g. "@work/calendar/oct.md".';

export const BASE_TOOLS: ToolDef[] = [
  {
    name: "list_files",
    description:
      'List the files and folders in a folder of this space. Folders end with "/". A path like "@work/calendar" lists a folder of another space, if this space has been granted read access to it.',
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Folder relative to the space root. Omit or use "" for the root. "@<space>/<folder>" for a granted folder of another space.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: 'Read a text file in this space, or with "@<space>/<path>" a file in a granted part of another space.',
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: PATH_LOCAL_OR_OTHER } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_page",
    description:
      "Look at one original PDF page as an image, including handwriting, equations and diagrams OCR may have misread. Page numbers start at 1. The result identifies the source path and page: cite both. Uses the same course permissions and @space grants as read_file. For text, use read_file first; request only the page needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: PATH_LOCAL_OR_OTHER },
        page: { type: "integer", minimum: 1, maximum: 10000 },
      },
      required: ["path", "page"],
      additionalProperties: false,
    },
  },
  {
    name: "search_files",
    description:
      'Search text files up to 2 MiB, including imported OCR text. One word matches literal lines; multiple words match across nearby lines and their heading, ranked by relevance. Returns path:line: text, with an explicit notice if scan or output limits are reached. Narrow path/query to continue. With path "@<space>/<folder>" it searches a granted folder of another space instead.',
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for." },
        path: { type: "string", description: 'Folder to search, relative to the space root. Omit for the whole space. "@<space>/<folder>" for a granted folder of another space.' },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      'Create or replace a text file in this space with the given contents. The user is asked to approve every write first, and may decline. Only this space can be written: "@<space>/..." paths are always refused.',
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Path relative to the space root, e.g. "notes/today.md".' },
        contents: { type: "string", description: "The complete new contents of the file." },
      },
      required: ["path", "contents"],
      additionalProperties: false,
    },
  },
  {
    name: "request_access",
    description:
      'Ask the user to let this space read a folder or file of another space. Nothing in another space can be read without this. The user sees your reason and answers: allow once (this reply only), allow always, or deny. Access is read-only. Ask for the narrowest folder or file that does the job, and only when the user\'s request needs it. Once granted, read it with paths starting "@<space>/<path>".',
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        space: { type: "string", description: 'Name of the other space, e.g. "work".' },
        path: { type: "string", description: 'Folder or file inside that space, relative to its root, e.g. "calendar".' },
        reason: { type: "string", description: "One short sentence for the user on why you need it." },
      },
      required: ["space", "path", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "app_guide",
    description:
      "Where everything is in Phaethon, the app the user is talking to you in: spaces and their menus, adding files and folders, attaching files, the views, keyboard shortcuts and every section of Settings, by the names shown in the app. Call it before telling the user where something is or how to change a setting.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "study_attempt",
    description:
      "Find completed quiz attempts in this space. Call with no path to list them, then call with an attempt path from that list to read the answers and results. Read the quiz itself with read_file using the quiz path in the attempt. This tool cannot read other hidden app state or another space.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "A quiz attempt path returned by this tool. Omit to list completed attempts." } },
      additionalProperties: false,
    },
  },
];

/** Claude models only: prose that must reach the user verbatim mid-turn. */
export const SEND_TO_USER: ToolDef = {
  name: "send_to_user",
  description:
    "Show the user a message now, exactly as written, before your next tool call: an explanation they need before a question, a worked step, an exact value. Markdown and math render as in a reply. Text you write after your last tool call doesn't need this.",
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: { message: { type: "string", description: "The message, in Markdown." } },
    required: ["message"],
    additionalProperties: false,
  },
};

/** Lesson tools, offered in tutor modes. Property order is deliberate: reasoning before commitment. */
export const LESSON_TOOLS: ToolDef[] = [
  {
    name: "plan_lesson",
    description:
      "Save the plan for teaching a new topic and show the user its prerequisite map. Introduce the plan in two or three sentences before calling (with send_to_user on Claude). The turn ends after this call so the user can respond.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the user will understand at the end, as one sentence." },
        strands: {
          type: "array",
          description: "The prerequisite strands the goal depends on, with what the user has already shown about each.",
          items: {
            type: "object",
            properties: { strand: { type: "string" }, known: { type: "string", description: "What the user already holds here, or \"not yet probed\"." } },
            required: ["strand", "known"],
            additionalProperties: false,
          },
        },
        premises: { type: "array", items: { type: "string" }, description: "The few starting points everything rests on, each a plain claim (with its course source if there is one)." },
        map: {
          type: "string",
          description:
            'A mermaid flowchart of prerequisites: first line "graph TD", then one edge per line like "limits[Limits] --> derivative[The derivative]" meaning limits is needed before derivative. Node ids are lowercase words joined by hyphens and stay the same for the rest of the lesson. No cycles.',
        },
      },
      required: ["goal", "strands", "premises", "map"],
      additionalProperties: false,
    },
  },
  {
    name: "check",
    description:
      'Ask the user one multiple-choice question and end the turn; their answer, how sure they were and their reasoning come back as the result. Teach before a "check"; a "predict" comes before the step it sets up. Don\'t add an "I don\'t know" option; the app adds one.',
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["predict", "check"], description: '"predict" before teaching a step, "check" after it.' },
        nodeId: { type: "string", description: "The plan_lesson node this question is about, when there is a plan." },
        question: { type: "string", description: "The question, in Markdown; math in KaTeX." },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 6,
          description: "The choices. Each wrong one is the answer under one specific misconception, written in the same form as the right one.",
          items: {
            type: "object",
            properties: { value: { type: "string", description: "A short stable id, e.g. \"a\"." }, label: { type: "string", description: "What the user sees." } },
            required: ["value", "label"],
            additionalProperties: false,
          },
        },
        multiSelect: { type: "boolean", description: "True when more than one option is right." },
        explanation: { type: "string", description: "Work the question out here first: why the right answer is right and which misconception each wrong option stands for." },
        correctAnswer: {
          description: "The value of the right option (an array of values when multiSelect), chosen after the explanation.",
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
      },
      required: ["role", "question", "options", "explanation", "correctAnswer"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_back",
    description:
      "Ask the user to explain an idea in their own words and end the turn; what they write, how sure they were and their reasoning come back as the result. Grade it against your model answer.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "The plan_lesson node this is about, when there is a plan." },
        question: { type: "string", description: "What to explain, in Markdown." },
        modelAnswer: { type: "string", description: "The complete answer you will grade against, with its reasoning, written now and not changed later." },
      },
      required: ["question", "modelAnswer"],
      additionalProperties: false,
    },
  },
];

export const BASE_TOOL_NAMES = BASE_TOOLS.map((t) => t.name);

export function toolDefs(opts: { claude: boolean; lesson: boolean }): ToolDef[] {
  return [...BASE_TOOLS, ...(opts.claude ? [SEND_TO_USER] : []), ...(opts.lesson ? LESSON_TOOLS : [])];
}

export function toolNamed(name: string): ToolDef | undefined {
  return [...BASE_TOOLS, SEND_TO_USER, ...LESSON_TOOLS].find((t) => t.name === name);
}
