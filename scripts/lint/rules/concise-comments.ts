// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Context, Rule, SourceCode } from "@oxlint/plugins";
import { checkCommentBlocks } from "../comment-policy.mjs";

type CommentSource = Pick<SourceCode, "text" | "getAllComments">;
type CommentRuleContext = Pick<Context, "report"> & { sourceCode: CommentSource };

function createConciseCommentsVisitor(sourceCode: CommentSource, report: Context["report"]) {
  return {
    Program() {
      const spans = sourceCode
        .getAllComments()
        .filter((comment) => comment.type !== "Shebang")
        .map(({ start, end }) => ({ start, end }));
      for (const violation of checkCommentBlocks(sourceCode.text, spans, { tabWidth: 2 })) {
        report({
          loc: { line: violation.line, column: violation.column },
          message: violation.message,
        });
      }
    },
  };
}

export const conciseCommentsRule = {
  meta: {
    type: "layout",
    docs: { description: "Keep ordinary comment blocks short and scannable." },
  },
  create(context: CommentRuleContext) {
    return createConciseCommentsVisitor(context.sourceCode, context.report);
  },
} satisfies Rule;

export default conciseCommentsRule;
