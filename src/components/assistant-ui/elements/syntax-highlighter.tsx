import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { Suspense, lazy } from "react";

const Highlighted = lazy(() => import("./syntax-highlighter-impl"));

/**
 * Syntax colours for code blocks, loaded on first use. Until the highlighter
 * arrives (a moment, once) the code shows as plain text in the same block, so
 * nothing is ever hidden. Colour is decoration only: the code reads the same
 * without it (and in forced-colours mode it is plain).
 */
export function SyntaxHighlighter(props: SyntaxHighlighterProps) {
  const { Pre, Code } = props.components;
  return (
    <Suspense
      fallback={
        <Pre>
          <Code>{props.code}</Code>
        </Pre>
      }
    >
      <Highlighted {...props} />
    </Suspense>
  );
}
