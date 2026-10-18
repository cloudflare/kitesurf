// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// CSS Counter Styles 3 §9 defines the @counter-style rule.
import { expect, test } from "./harness";

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string } };
}

test("CSSCounterStyleRule: classification, descriptors, mutation, global shape", async ({
  cdpSession: cdp,
}) => {
  const r = (await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const trailingEscape = String.fromCharCode(92);
      const st = document.createElement("style");
      st.textContent =
        '@counter-style thumbs {\\n' +
        '  system: cyclic;\\n' +
        '  symbols: "X" "Y";\\n' +
        '  suffix: ") ";\\n' +
        '  pad: "P" 3;\\n' +
        '  additive-symbols: "V" 5, "I" 1;\\n' +
        '  negative: "(" ")";\\n' +
        '  range: 0 infinite;\\n' +
        '  fallback: decimal;\\n' +
        '  speak-as: numbers;\\n' +
        '  hasOwnProperty: ignored;\\n' +
        '}\\n' +
        '@counter-style none {}\\n' + // invalid name: whole rule dropped
        '@counter-style bogus-system { system: not-a-thing; symbols: "X"; }\\n' +
        '@counter-style dangling' + trailingEscape + ' { system: cyclic; }\\n' +
        '@counter-style dangling-value { system: cyclic' + trailingEscape + '; symbols: "D"; }';
      document.head.appendChild(st);
      const rr = st.sheet.cssRules;

      const err = (fn) => { try { fn(); return "ok"; } catch (e) { return e.name || "TypeError"; } };

      const rule = rr[0];
      const suffixBefore = rule.suffix;
      rule.system = "extends decimal"; // rejected: would change algorithm family
      const systemAfterBadSet = rule.system;
      rule.suffix = ""; // invalid <symbol> (zero tokens): rejected, old value kept
      const suffixAfterBadSet = rule.suffix;
      rule.suffix = trailingEscape;
      const suffixAfterTrailingEscape = rule.suffix;
      rule.suffix = '"!"'; // valid <string> symbol: mirrors into cssText
      const suffixAfterGoodSet = rule.suffix;
      const cssTextAfterSet = rule.cssText;
      const nameBefore = rule.name;
      rule.name = "foo bar";
      const nameAfterInvalidSyntax = rule.name;
      rule.name = "initial";
      const nameAfterReservedKeyword = rule.name;
      rule.name = trailingEscape;
      const nameAfterTrailingEscape = rule.name;
      rule.name = "thumbs-up";
      const nameAfterValidSet = rule.name;

      return JSON.stringify({
        ruleCount: rr.length,
        name: rr[0].constructor.name,
        type: rr[0].type,
        typeConst: rr[0].type === CSSRule.COUNTER_STYLE_RULE,
        pad: rr[0].pad,
        additiveSymbols: rr[0].additiveSymbols,
        negative: rr[0].negative,
        range: rr[0].range,
        fallback: rr[0].fallback,
        speakAs: rr[0].speakAs,
        ruleName: nameBefore,
        bogusRuleName: rr[1].name,
        bogusSystemDropped: rr[1].system === "",
        danglingNameDropped: [...rr].every(r => r.name !== "dangling"),
        danglingDescriptorDropsRule: [...rr].every(r => r.name !== "dangling-value"),
        systemRejectedAlgorithmChange: systemAfterBadSet === "cyclic",
        suffixRejectedInvalid: suffixAfterBadSet === suffixBefore,
        suffixCanonicalizesTrailingEscape: suffixAfterTrailingEscape !== suffixBefore,
        suffixAcceptedValid: suffixAfterGoodSet === '"!"',
        cssTextReflectsSet: cssTextAfterSet.indexOf('suffix: "!"') !== -1,
        nameRejectedInvalidSyntax: nameAfterInvalidSyntax === nameBefore,
        nameRejectedReservedKeyword: nameAfterReservedKeyword === nameBefore,
        nameCanonicalizesTrailingEscape: nameAfterTrailingEscape !== nameBefore,
        nameAcceptedValid: nameAfterValidSet === "thumbs-up",
        insertInvalidNameThrows: err(() => st.sheet.insertRule("@counter-style none { system: cyclic; symbols: \\"X\\"; }")),
        hasOwnGlobal: Object.prototype.hasOwnProperty.call(window, "CSSCounterStyleRule"),
        globalIsCtor: rr[0] instanceof window.CSSCounterStyleRule,
      });
    })()`,
    returnByValue: true,
  })) as EvalResult;
  expect(r.exceptionDetails).toBeFalsy();
  expect(JSON.parse(String(r.result?.value))).toEqual({
    ruleCount: 2,
    name: "CSSCounterStyleRule",
    type: 11,
    typeConst: true,
    pad: '3 "P"',
    additiveSymbols: '5 "V", 1 "I"',
    negative: '"(" ")"',
    range: "0 infinite",
    fallback: "decimal",
    speakAs: "numbers",
    ruleName: "thumbs",
    bogusRuleName: "bogus-system",
    bogusSystemDropped: true,
    danglingNameDropped: true,
    danglingDescriptorDropsRule: true,
    systemRejectedAlgorithmChange: true,
    suffixRejectedInvalid: true,
    suffixCanonicalizesTrailingEscape: true,
    suffixAcceptedValid: true,
    cssTextReflectsSet: true,
    nameRejectedInvalidSyntax: true,
    nameRejectedReservedKeyword: true,
    nameCanonicalizesTrailingEscape: true,
    nameAcceptedValid: true,
    insertInvalidNameThrows: "SyntaxError",
    hasOwnGlobal: true,
    globalIsCtor: true,
  });
}, 120_000);
