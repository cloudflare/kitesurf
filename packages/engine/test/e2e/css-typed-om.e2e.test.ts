// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("Typed OM maps round-trip keyword and numeric values", async ({ page }) => {
  await page.goto("data:text/html,<!doctype html><div id='target'></div>");
  const result = await page.evaluate(() => {
    const g = globalThis as any;
    const constructorName = (error: any) => error?.constructor?.name;
    const errorName = (error: any) => String(error?.name || constructorName(error) || "");
    const errorDetails = (error: any) => ({
      errorName: errorName(error),
      errorMessage: `${error.name}: ${error.message}`,
    });
    const capture = (run: () => unknown) => {
      try {
        run();
        return { threw: false, errorName: "", errorMessage: "" };
      } catch (error) {
        return { threw: true, ...errorDetails(error) };
      }
    };
    const target = document.getElementById("target") as any;
    const firstKeyword = new g.CSSKeywordValue("rtl");
    target.attributeStyleMap.set("direction", firstKeyword);
    const direction = target.attributeStyleMap.get("direction");
    target.attributeStyleMap.set("direction", new g.CSSKeywordValue("inherit"));
    const wideKeyword = target.attributeStyleMap.get("direction");
    target.attributeStyleMap.set(
      "direction",
      new g.CSSUnparsedValue([new g.CSSVariableReferenceValue("--flow")]),
    );
    const variable = target.attributeStyleMap.get("direction");
    target.attributeStyleMap.set("direction", new g.CSSKeywordValue("rtl"));

    const percentageSource = new g.CSSUnitValue(50, "percent");
    target.attributeStyleMap.set("opacity", percentageSource);
    percentageSource.value = 10;
    const specifiedPercentage = target.attributeStyleMap.get("opacity");
    const computedPercentage = target.computedStyleMap().get("opacity");
    target.attributeStyleMap.set(
      "opacity",
      new g.CSSMathSum(new g.CSSUnitValue(2, "number"), new g.CSSUnitValue(3, "number")),
    );
    const specifiedCalc = target.attributeStyleMap.get("opacity");
    const computedCalc = target.computedStyleMap().get("opacity");
    target.attributeStyleMap.set("opacity", "0.75");
    const stringValue = target.attributeStyleMap.get("opacity");
    target.attributeStyleMap.set("opacity", new g.CSSUnitValue(0.25, "number"));
    const opacity = target.computedStyleMap().get("opacity");
    target.attributeStyleMap.set("transition-duration", g.CSS.s(1), "2s");
    target.attributeStyleMap.append("transition-duration", g.CSS.s(3));
    const durations = target.attributeStyleMap.getAll("transition-duration");
    target.style.color = "red";
    const color = target.attributeStyleMap.get("color");
    target.style.textShadow = "1px 1px red, 2px 2px blue";
    const shadows = target.attributeStyleMap.getAll("text-shadow");
    const parsedWidth = g.CSSStyleValue.parse("width", "10px");
    const parsedDurations = g.CSSStyleValue.parseAll("transition-duration", "1s, 2s");
    const doubleDash = new g.CSSKeywordValue("--");
    const incompatibleSumRejected = capture(() => {
      new g.CSSMathSum(g.CSS.px(1), g.CSS.s(1));
    }).threw;
    const declarationInjectionRejected = capture(() => {
      target.attributeStyleMap.set("width", "1px; color: blue");
    }).threw;
    const declarationPriorityRejected = capture(() => {
      g.CSSStyleValue.parse("width", "1px !important");
    }).threw;
    target.attributeStyleMap.set("width", g.CSS.px(1));
    const reifiedAssociationRejected = capture(() => {
      target.attributeStyleMap.set("height", target.attributeStyleMap.get("width"));
    }).threw;
    let parsedNamedColor = "";
    const parsedColor = capture(() => {
      parsedNamedColor = String(g.CSSColorValue.parse("rebeccapurple"));
    });
    const parsedNamedColorError = parsedColor.errorMessage;
    const cssStyleValueConstructRejected = capture(() => {
      new g.CSSStyleValue();
    }).threw;
    const cssStyleValueReflectConstructRejected = capture(() => {
      Reflect.construct(g.CSSStyleValue, [], g.CSSUnitValue);
    }).threw;
    class DerivedUnit extends g.CSSUnitValue {}
    class DerivedSum extends g.CSSMathSum {}
    class DerivedTranslate extends g.CSSTranslate {}
    const derivedUnit = new (DerivedUnit as any)(2, "px");
    const derivedSum = new (DerivedSum as any)(g.CSS.px(1), g.CSS.px(2));
    const derivedTranslate = new (DerivedTranslate as any)(g.CSS.px(1), g.CSS.px(2));
    const unparsed = new g.CSSUnparsedValue(["x"]);
    const variableReference = new g.CSSVariableReferenceValue("--x", unparsed);
    const sum = new g.CSSMathSum(g.CSS.px(1));
    const rejection = capture(() => {
      target.attributeStyleMap.set("direction", new g.CSSUnitValue(2, "px"));
    });
    return {
      sameInlineMap: target.attributeStyleMap === target.attributeStyleMap,
      sameComputedMap: target.computedStyleMap() === target.computedStyleMap(),
      directionClass: direction.constructor.name,
      direction: direction.value,
      wideKeyword: wideKeyword.value,
      variable: String(variable),
      specifiedPercentage: [specifiedPercentage.value, specifiedPercentage.unit],
      computedPercentage: [computedPercentage.value, computedPercentage.unit],
      specifiedCalc: specifiedCalc.constructor.name,
      computedCalc: [computedCalc.value, computedCalc.unit],
      stringValue: [stringValue.value, stringValue.unit],
      opacityClass: opacity.constructor.name,
      opacity: opacity.value,
      opacityUnit: opacity.unit,
      durations: durations.map((value: any) => [value.value, value.unit]),
      colorClass: color.constructor.name,
      shadowValueCount: shadows.length,
      parsedWidth: [parsedWidth.value, parsedWidth.unit],
      parsedDurations: parsedDurations.map((value: any) => [value.value, value.unit]),
      doubleDash: doubleDash.value,
      incompatibleSumRejected,
      declarationInjectionRejected,
      declarationPriorityRejected,
      reifiedAssociationRejected,
      parsedNamedColor,
      parsedNamedColorError,
      cssStyleValueConstructRejected,
      cssStyleValueReflectConstructRejected,
      derivedValues: [String(derivedUnit), String(derivedSum), String(derivedTranslate)],
      transformComponentInheritsStyleValue: g.CSSStyleValue.prototype.isPrototypeOf(
        g.CSSTransformComponent.prototype,
      ),
      parseLength: g.CSSStyleValue.parse.length,
      parseEnumerable: Object.prototype.propertyIsEnumerable.call(g.CSSStyleValue, "parse"),
      getEnumerable: Object.prototype.propertyIsEnumerable.call(
        g.StylePropertyMapReadOnly.prototype,
        "get",
      ),
      bindingShape: {
        mapIterator:
          g.StylePropertyMapReadOnly.prototype[Symbol.iterator] ===
          g.StylePropertyMapReadOnly.prototype.entries,
        unparsedIterable: [
          ...["entries", "keys", "values", "forEach"].map(
            (name) => g.CSSUnparsedValue.prototype[name] === (Array.prototype as any)[name],
          ),
          g.CSSUnparsedValue.prototype[Symbol.iterator] === Array.prototype[Symbol.iterator],
        ],
        unparsedLength:
          Object.prototype.hasOwnProperty.call(g.CSSUnparsedValue.prototype, "length") &&
          !Object.prototype.hasOwnProperty.call(unparsed, "length"),
        fallbackAccessor:
          Object.prototype.hasOwnProperty.call(g.CSSVariableReferenceValue.prototype, "fallback") &&
          variableReference.fallback === unparsed,
        inheritedStatics: [g.CSSUnitValue, g.CSSMathSum, g.CSSTransformValue].every(
          (C) =>
            Object.prototype.hasOwnProperty.call(C, "parse") &&
            Object.prototype.hasOwnProperty.call(C, "parseAll"),
        ),
        operatorInherited: !Object.prototype.hasOwnProperty.call(sum, "operator"),
      },
      uninjectedColor: target.style.color,
      rejected: rejection.threw,
      rejectionName: rejection.errorName,
      preservedDirection: target.style.direction,
    };
  });
  expect(result).toEqual({
    sameInlineMap: true,
    sameComputedMap: true,
    directionClass: "CSSKeywordValue",
    direction: "rtl",
    wideKeyword: "inherit",
    variable: "var(--flow)",
    specifiedPercentage: [50, "percent"],
    computedPercentage: [0.5, "number"],
    specifiedCalc: "CSSMathSum",
    computedCalc: [1, "number"],
    stringValue: [0.75, "number"],
    opacityClass: "CSSUnitValue",
    opacity: 0.25,
    opacityUnit: "number",
    durations: [
      [1, "s"],
      [2, "s"],
      [3, "s"],
    ],
    colorClass: "CSSStyleValue",
    shadowValueCount: 1,
    parsedWidth: [10, "px"],
    parsedDurations: [
      [1, "s"],
      [2, "s"],
    ],
    doubleDash: "--",
    incompatibleSumRejected: true,
    declarationInjectionRejected: true,
    declarationPriorityRejected: true,
    reifiedAssociationRejected: true,
    parsedNamedColor: "rebeccapurple",
    parsedNamedColorError: "",
    cssStyleValueConstructRejected: true,
    cssStyleValueReflectConstructRejected: true,
    derivedValues: ["2px", "calc(1px + 2px)", "translate(1px, 2px)"],
    transformComponentInheritsStyleValue: false,
    parseLength: 2,
    parseEnumerable: true,
    getEnumerable: true,
    bindingShape: {
      mapIterator: true,
      unparsedIterable: Array(5).fill(true),
      unparsedLength: true,
      fallbackAccessor: true,
      inheritedStatics: true,
      operatorInherited: true,
    },
    uninjectedColor: "red",
    rejected: true,
    rejectionName: "TypeError",
    preservedDirection: "rtl",
  });
});

test("Typed OM numeric objects implement arithmetic and complex values", async ({ page }) => {
  await page.goto("data:text/html,<!doctype html><div id='target'></div>");
  const result = await page.evaluate(() => {
    "use strict";
    const g = globalThis as any;
    const attempt = (run: () => unknown) => {
      try {
        run();
        return { threw: false, name: "" };
      } catch (error) {
        return { threw: true, name: (error as any).name };
      }
    };
    const sum = new g.CSSMathSum(1, g.CSS.number(2));
    const product = new g.CSSMathProduct(g.CSS.px(2), 3);
    const negate = new g.CSSMathNegate(g.CSS.px(2));
    const invert = new g.CSSMathInvert(g.CSS.s(2));
    const min = new g.CSSMathMin(g.CSS.px(3), g.CSS.px(1));
    const max = new g.CSSMathMax(g.CSS.px(3), g.CSS.px(1));
    const clamp = new g.CSSMathClamp(g.CSS.px(1), g.CSS.px(3), g.CSS.px(2));
    const hinted = new g.CSSMathSum(g.CSS.px(1), g.CSS.percent(1));
    const compound = new g.CSSMathProduct(g.CSS.px(1), g.CSS.s(1));

    const arrayWriteRejected = attempt(() => {
      sum.values[0] = g.CSS.number(9);
    }).threw;
    const arrayDeleteRejected = attempt(() => {
      delete sum.values[0];
    }).threw;
    const backingWriteRejected = attempt(() => {
      sum._values = null;
    }).threw;
    const valuesWriteRejected = attempt(() => {
      sum.values = [];
    }).threw;
    const operatorWriteRejected = attempt(() => {
      sum.operator = "max";
    }).threw;

    const errors = [
      () => new g.CSSMathSum(),
      () => new g.CSSMathMin(g.CSS.px(1), g.CSS.s(1)),
      () => g.CSS.number(1).div(0),
      () => g.CSS.px(1).toSum("number"),
      () => g.CSS.px(1).toSum("lemon"),
    ].flatMap((run) => {
      const result = attempt(run);
      return result.threw ? [result.name] : [];
    });

    const greedy = new g.CSSMathSum(g.CSS.cm(1), g.CSS.mm(10)).toSum("cm", "mm");
    const sorted = new g.CSSMathSum(g.CSS.px(1), g.CSS.em(1), g.CSS.rem(1)).toSum();
    const structuralA = new g.CSSMathSum(0, new g.CSSMathNegate(0));
    const structuralB = new g.CSSMathSum(g.CSS.number(0), new g.CSSMathNegate(g.CSS.number(0)));
    const structuralC = new g.CSSMathProduct(0, new g.CSSMathNegate(0));
    const absolute = new g.CSSMathSum(g.CSS.cm(1), g.CSS.mm(10)).toSum();
    const target = document.getElementById("target") as any;
    target.attributeStyleMap.set("width", min);
    const mappedMin = target.attributeStyleMap.get("width");

    return {
      globals: [
        "CSSNumericArray",
        "CSSMathProduct",
        "CSSMathNegate",
        "CSSMathInvert",
        "CSSMathMin",
        "CSSMathMax",
        "CSSMathClamp",
      ].map((name) => typeof g[name]),
      operators: [sum, product, negate, invert, min, max, clamp].map((value) => value.operator),
      array: {
        className: sum.values.constructor.name,
        values: [...sum.values].map((value: any) => [value.value, value.unit]),
        entries: [...sum.values.entries()].map(([index, value]: any) => [index, value.value]),
        arrayWriteRejected,
        arrayDeleteRejected,
        backingWriteRejected,
        valuesWriteRejected,
        operatorWriteRejected,
      },
      arithmetic: [
        g.CSS.px(10).add(g.CSS.px(5)).toString(),
        g.CSS.px(10).sub(g.CSS.px(5), g.CSS.px(2)).toString(),
        g.CSS.number(10).mul(g.CSS.px(5), 2).toString(),
        g.CSS.px(10).div(5, 2).toString(),
        g.CSS.px(10).min(g.CSS.px(5), g.CSS.px(2)).toString(),
        g.CSS.px(10).max(g.CSS.px(5), g.CSS.px(2)).toString(),
      ],
      unsimplified: [
        g.CSS.px(1).add(g.CSS.percent(1)).constructor.name,
        g.CSS.number(10).mul(g.CSS.px(5), g.CSS.px(2)).constructor.name,
        g.CSS.number(10).div(g.CSS.px(5)).constructor.name,
      ],
      conversions: [
        product.to("px").toString(),
        negate.to("px").toString(),
        new g.CSSMathProduct(g.CSS.px(4), new g.CSSMathInvert(g.CSS.px(2))).to("number").toString(),
        min.to("px").toString(),
        max.to("px").toString(),
        clamp.to("px").toString(),
      ],
      types: [
        g.CSS.number(1).type(),
        g.CSS.px(1).type(),
        hinted.type(),
        compound.type(),
        invert.type(),
      ],
      equals: [
        structuralA.equals(structuralB),
        structuralA.equals(structuralB, structuralA),
        structuralA.equals(structuralC),
      ],
      sums: {
        greedy: [...greedy.values].map((value: any) => value.toString()),
        sorted: [...sorted.values].map((value: any) => value.toString()),
        absolute: [absolute.values[0].unit, Math.round(absolute.values[0].value * 1e6) / 1e6],
      },
      mappedMin: [mappedMin.constructor.name, String(mappedMin)],
      errors,
      serialization: [
        String(product),
        String(negate),
        String(invert),
        String(min),
        String(max),
        String(clamp),
      ],
    };
  });

  expect(result).toEqual({
    globals: Array(7).fill("function"),
    operators: ["sum", "product", "negate", "invert", "min", "max", "clamp"],
    array: {
      className: "CSSNumericArray",
      values: [
        [1, "number"],
        [2, "number"],
      ],
      entries: [
        [0, 1],
        [1, 2],
      ],
      arrayWriteRejected: true,
      arrayDeleteRejected: true,
      backingWriteRejected: true,
      valuesWriteRejected: true,
      operatorWriteRejected: true,
    },
    arithmetic: ["15px", "3px", "100px", "1px", "2px", "10px"],
    unsimplified: ["CSSMathSum", "CSSMathProduct", "CSSMathProduct"],
    conversions: ["6px", "-2px", "2", "1px", "3px", "2px"],
    types: [
      {},
      { length: 1 },
      { length: 1, percentHint: "length" },
      { length: 1, time: 1 },
      { time: -1 },
    ],
    equals: [true, true, false],
    sums: {
      greedy: ["2cm", "0mm"],
      sorted: ["1em", "1px", "1rem"],
      absolute: ["px", 75.590551],
    },
    mappedMin: ["CSSMathMin", "min(3px, 1px)"],
    errors: ["SyntaxError", "TypeError", "RangeError", "TypeError", "SyntaxError"],
    serialization: [
      "calc(2px * 3)",
      "calc(-1 * 2px)",
      "calc(1 / 2s)",
      "min(3px, 1px)",
      "max(3px, 1px)",
      "clamp(1px, 3px, 2px)",
    ],
  });
});

test("Typed OM transform objects validate, serialize, and produce matrices", async ({ page }) => {
  await page.goto(
    "data:text/html,<!doctype html><div id='target' style='transform:translate(10px,20px) rotate(90deg)'></div>",
  );
  const result = await page.evaluate(() => {
    "use strict";
    const g = globalThis as any;
    const capture = (run: () => unknown) => {
      try {
        run();
        return { threw: false, name: "" };
      } catch (error) {
        return { threw: true, name: (error as any).name };
      }
    };
    const errors = [
      () => new g.CSSTranslate(g.CSS.deg(1), g.CSS.px(0)),
      () => new g.CSSTranslate(g.CSS.px(0), g.CSS.px(0), g.CSS.percent(1)),
      () => new g.CSSRotate(g.CSS.number(1)),
      () => new g.CSSRotate(g.CSS.px(1), 0, 0, g.CSS.deg(1)),
      () => new g.CSSScale(g.CSS.px(1), 1),
      () => new g.CSSSkew(0, g.CSS.deg(0)),
      () => new g.CSSPerspective(g.CSS.percent(1)),
      () => new g.CSSTransformValue([]),
    ].flatMap((run) => {
      const result = capture(run);
      return result.threw ? [result.name] : [];
    });

    const translate = new g.CSSTranslate(g.CSS.px(1), g.CSS.percent(2), g.CSS.px(3));
    const preserved = (() => {
      const result = capture(() => {
        translate.z = g.CSS.percent(4);
      });
      return result.threw ? String(translate.z) : "";
    })();
    const rotate = new g.CSSRotate(1, 2, 3, g.CSS.deg(90));
    const scale = new g.CSSScale(2, 3, 4);
    const skew = new g.CSSSkew(g.CSS.deg(90), g.CSS.turn(0));
    const perspective = new g.CSSPerspective(g.CSS.px(-1));
    const matrixComponent = new g.CSSMatrixComponent(
      new g.DOMMatrix([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    );
    matrixComponent.is2D = true;
    const readonlyMatrixRejected = capture(() => {
      matrixComponent.matrix = new g.DOMMatrixReadOnly();
    }).threw;

    const sequence = new g.CSSTransformValue([
      new g.CSSScale(2, 2),
      new g.CSSRotate(g.CSS.deg(90)),
    ]);
    sequence[1] = new g.CSSTranslate(g.CSS.px(5), g.CSS.px(6));
    sequence[2] = new g.CSSScale(3, 4);
    const badIndex = capture(() => {
      sequence[4] = new g.CSSScale(1, 1);
    }).name;
    const readonly = capture(() => {
      sequence.is2D = false;
    }).name;
    const backingWrite = capture(() => {
      sequence._components = [];
    }).name;

    const mutable = new g.DOMMatrix([1, 2, 3, 4, 5, 6]);
    mutable.a = 7;
    mutable.m43 = 8;
    const readonlyMatrix = new g.DOMMatrixReadOnly([2, 0, 0, 2, 3, 4]);
    const hiddenMatrixState = [
      !Object.prototype.hasOwnProperty.call(readonlyMatrix, "_values"),
      !Object.prototype.hasOwnProperty.call(readonlyMatrix, "_is2D"),
    ];
    readonlyMatrix._values = Array(16).fill(99);
    readonlyMatrix._is2D = false;
    hiddenMatrixState.push(readonlyMatrix.m11 === 2, readonlyMatrix.is2D);
    const multiplied = new g.DOMMatrix().translateSelf(2, 3).scaleSelf(4, 5);
    const compatible3DFields = new g.DOMMatrix();
    compatible3DFields.m13 = 0;
    compatible3DFields.m33 = 1;
    compatible3DFields.m44 = 1;
    const matrix2DTransitions = [compatible3DFields.is2D];
    compatible3DFields.m33 = 2;
    matrix2DTransitions.push(compatible3DFields.is2D);
    const componentMatrices = [
      new g.CSSTranslate(g.CSS.px(1), g.CSS.px(2), g.CSS.px(3)).toMatrix(),
      rotate.toMatrix(),
      scale.toMatrix(),
      new g.CSSSkew(g.CSS.deg(10), g.CSS.deg(20)).toMatrix(),
      new g.CSSPerspective(g.CSS.px(10)).toMatrix(),
      matrixComponent.toMatrix(),
    ];
    const round = (value: number) => Math.round(value * 1e6) / 1e6;
    const fields = (matrix: any) =>
      [
        matrix.m11,
        matrix.m12,
        matrix.m13,
        matrix.m14,
        matrix.m21,
        matrix.m22,
        matrix.m23,
        matrix.m24,
        matrix.m31,
        matrix.m32,
        matrix.m33,
        matrix.m34,
        matrix.m41,
        matrix.m42,
        matrix.m43,
        matrix.m44,
      ].map(round);

    const relativeErrors = [
      new g.CSSTranslate(g.CSS.px(1), g.CSS.em(1)),
      new g.CSSPerspective(g.CSS.em(1)),
    ].flatMap((component) => {
      const result = capture(() => component.toMatrix());
      return result.threw ? [result.name] : [];
    });

    const parsed = g.CSSStyleValue.parse("transform", "translate(10px, 20%) rotate(30deg)");
    const computed = (document.getElementById("target") as any).computedStyleMap().get("transform");
    const sourceMatrix = new g.DOMMatrix([1, 0, 0, 1, 7, 8]);
    const source = new g.CSSTransformValue([
      new g.CSSTranslate(g.CSS.px(1), g.CSS.px(2)),
      new g.CSSRotate(g.CSS.deg(3)),
      new g.CSSScale(4, 5),
      new g.CSSSkew(g.CSS.deg(6), g.CSS.deg(7)),
      new g.CSSSkewX(g.CSS.deg(8)),
      new g.CSSSkewY(g.CSS.deg(9)),
      new g.CSSPerspective(g.CSS.px(10)),
      new g.CSSMatrixComponent(sourceMatrix),
    ]);
    const target = document.getElementById("target") as any;
    target.attributeStyleMap.set("transform", source);
    source[0].x.value = 99;
    sourceMatrix.e = 99;
    source[1] = new g.CSSScale(99, 99);
    const mapped = target.attributeStyleMap.get("transform");
    const mappedAgain = target.attributeStyleMap.get("transform");
    const mappedValues = [mapped[0].x.value, mapped[1].angle.value, mapped[7].matrix.e];
    mapped[0].x.value = 88;
    const mathSerialization = String(
      new g.CSSTransformValue([
        new g.CSSTranslate(new g.CSSMathSum(g.CSS.px(1), g.CSS.em(1)), g.CSS.px(0)),
        new g.CSSRotate(new g.CSSMathSum(g.CSS.deg(90), g.CSS.turn(1))),
        new g.CSSSkew(new g.CSSMathProduct(g.CSS.deg(90), 2), g.CSS.turn(0)),
        new g.CSSScale(new g.CSSMathProduct(g.CSS.number(1), g.CSS.number(2)), 1),
      ]),
    );
    return {
      errors,
      preserved,
      serialization: [
        String(translate),
        String(rotate),
        String(scale),
        String(skew),
        String(perspective),
        String(matrixComponent),
      ],
      sequence: {
        length: sequence.length,
        values: [...sequence].map(String),
        entries: [...sequence.entries()].map(([index, value]: any) => [index, String(value)]),
        badIndex,
        readonly,
        backingWrite,
        backingHidden:
          !("_components" in sequence) && !Object.keys(sequence).includes("_components"),
        iterableIdentities: [
          ...["entries", "keys", "values", "forEach"].map(
            (name) => g.CSSTransformValue.prototype[name] === (Array.prototype as any)[name],
          ),
          g.CSSTransformValue.prototype[Symbol.iterator] === Array.prototype[Symbol.iterator],
        ],
      },
      transformComponentStringifier: Object.prototype.hasOwnProperty.call(
        g.CSSTransformComponent.prototype,
        "toString",
      ),
      matrixComponentMutable:
        matrixComponent.matrix instanceof g.DOMMatrix && readonlyMatrixRejected,
      matrixAliases: [
        mutable.a,
        mutable.m11,
        mutable.b,
        mutable.c,
        mutable.e,
        mutable.m43,
        mutable.is2D,
      ],
      hiddenMatrixState,
      matrix2DTransitions,
      multiplied: fields(multiplied),
      componentMatrices: componentMatrices.map(fields),
      listMatrix: fields(sequence.toMatrix()),
      relativeErrors,
      parsed: [parsed.constructor.name, parsed.length, String(parsed), parsed.is2D],
      computed: [computed.constructor.name, computed.length, String(computed), computed.is2D],
      mapped: {
        className: mapped.constructor.name,
        componentClasses: [...mapped].map((value: any) => value.constructor.name),
        componentsCloned: [...mapped].every((value: any, index: number) => value !== source[index]),
        nestedCloned: [mapped[0].x !== source[0].x, mapped[7].matrix !== sourceMatrix],
        values: mappedValues,
        mutableMatrixClass: mapped[7].matrix.constructor.name,
        repeatGetIndependent:
          mappedAgain !== mapped && mappedAgain[0] !== mapped[0] && mappedAgain[0].x.value === 1,
      },
      mathSerialization,
      independent: !g.CSSStyleValue.prototype.isPrototypeOf(g.CSSTransformComponent.prototype),
    };
  });

  expect(result).toEqual({
    errors: Array(8).fill("TypeError"),
    preserved: "3px",
    serialization: [
      "translate3d(1px, 2%, 3px)",
      "rotate3d(1, 2, 3, 90deg)",
      "scale3d(2, 3, 4)",
      "skew(90deg)",
      "perspective(calc(-1px))",
      "matrix(1, 2, 5, 6, 13, 14)",
    ],
    sequence: {
      length: 3,
      values: ["scale(2, 2)", "translate(5px, 6px)", "scale(3, 4)"],
      entries: [
        [0, "scale(2, 2)"],
        [1, "translate(5px, 6px)"],
        [2, "scale(3, 4)"],
      ],
      badIndex: "TypeError",
      readonly: "TypeError",
      backingWrite: "TypeError",
      backingHidden: true,
      iterableIdentities: Array(5).fill(true),
    },
    transformComponentStringifier: true,
    matrixComponentMutable: true,
    matrixAliases: [7, 7, 2, 3, 5, 8, false],
    hiddenMatrixState: [true, true, true, true],
    matrix2DTransitions: [true, false],
    multiplied: [4, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1, 0, 2, 3, 0, 1],
    componentMatrices: [
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1],
      [
        0.071429, 0.944641, -0.320237, 0, -0.658927, 0.285714, 0.695833, 0, 0.748808, 0.16131,
        0.642857, 0, 0, 0, 0, 1,
      ],
      [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1],
      [1, 0.36397, 0, 0, 0.176327, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -0.1, 0, 0, 0, 1],
      [1, 2, 0, 0, 5, 6, 0, 0, 0, 0, 1, 0, 13, 14, 0, 1],
    ],
    listMatrix: [6, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1, 0, 10, 12, 0, 1],
    relativeErrors: ["TypeError", "TypeError"],
    parsed: ["CSSTransformValue", 2, "translate(10px, 20%) rotate(30deg)", true],
    computed: ["CSSTransformValue", 2, "translate(10px, 20px) rotate(90deg)", true],
    mapped: {
      className: "CSSTransformValue",
      componentClasses: [
        "CSSTranslate",
        "CSSRotate",
        "CSSScale",
        "CSSSkew",
        "CSSSkewX",
        "CSSSkewY",
        "CSSPerspective",
        "CSSMatrixComponent",
      ],
      componentsCloned: true,
      nestedCloned: [true, true],
      values: [1, 3, 7],
      mutableMatrixClass: "DOMMatrix",
      repeatGetIndependent: true,
    },
    mathSerialization:
      "translate(calc(1em + 1px), 0px) rotate(calc(90deg + 360deg)) skew(calc(2 * 90deg)) scale(calc(1 * 2), 1)",
    independent: true,
  });
});

test("Typed OM color subclasses normalize, validate, and parse channels", async ({ page }) => {
  const result = await page.evaluate(() => {
    "use strict";
    const g = globalThis as any;
    const attempt = (run: () => unknown) => {
      try {
        run();
        return { threw: false, name: "" };
      } catch (error) {
        return { threw: true, name: (error as any).name };
      }
    };
    const rgb = new g.CSSRGB(0.5, g.CSS.number(73), g.CSS.percent(91));
    const hsl = new g.CSSHSL(undefined, 0.7, g.CSS.percent(91));
    const hwb = new g.CSSHWB(g.CSS.grad(101), 0.2, 0.3, g.CSS.percent(0.4));
    const lab = new g.CSSLab(0.2, 7, g.CSS.number(8), g.CSS.percent(0.4));
    const lch = new g.CSSLCH(g.CSS.percent(27), 0.7, 8);
    const oklab = new g.CSSOKLab(g.CSS.percent(27), 7, g.CSS.number(8));
    const oklch = new g.CSSOKLCH(0.2, 0.7, g.CSS.rad(8), g.CSS.percent(0.4));
    const color = new g.CSSColor("display-p3", [0.1, g.CSS.percent(20), "none"], 0.5);
    const originalChannels = color.channels;
    color.channels[0] = g.CSS.percent(40);
    const serializedColor = String(color);
    color.channels = [0.6, 0.7, 0.8];
    const channel = (value: any) => [value.constructor.name, value.value, value.unit];
    const errors = [
      () => new g.CSSRGB(g.CSS.deg(1), 0, 0),
      () => new g.CSSRGB(0, 0, 0, g.CSS.number(1)),
      () => new g.CSSHSL(g.CSS.px(1), 0, 0),
      () => new g.CSSHWB(180, 0, 0),
      () => new g.CSSHWB(g.CSS.px(1), 0, 0),
      () => new g.CSSLab(g.CSS.number(1), 0, 0),
      () => new g.CSSLCH(0, g.CSS.number(1), 0),
      () => new g.CSSOKLCH(0, 0, g.CSS.number(1)),
      () => new g.CSSColor("display-p3", [g.CSS.number(1)]),
      () => new g.CSSColor("display-p3", [], g.CSS.percent(1)),
      // CSS Typed OM 2 §4.6 requires SyntaxError for invalid channel values.
      () => {
        color.channels[0] = g.CSS.number(1);
      },
      () => color.channels.push(g.CSS.number(1)),
    ].flatMap((run) => {
      const result = attempt(run);
      return result.threw ? [result.name] : [];
    });
    const backingWriteRejected = attempt(() => {
      color._channels = [];
    }).threw;
    const target = document.createElement("div") as any;
    target.attributeStyleMap.set("color", color);
    const clonedColor = target.attributeStyleMap.get("color");
    color.channels[1] = 0.9;
    const cloneIndependent = String(clonedColor) === "color(display-p3 60% 70% 80% / 0.5)";
    color.channels[1] = 0.7;
    const parsed = [
      g.CSSColorValue.parse("#00bfff"),
      g.CSSColorValue.parse("hsla(123, 100%, 20%, .5)"),
      g.CSSColorValue.parse("hwb(200 31% 38% / 0.5)"),
      g.CSSColorValue.parse("blue"),
      g.CSSColorValue.parse("transparent"),
      g.CSSColorValue.parse("GrayText"),
    ];
    const parseErrors = ["abcdef", "initial", "inherit", "abc()", "--foo"].flatMap((value) => {
      const result = attempt(() => g.CSSColorValue.parse(value));
      return result.threw ? [result.name] : [];
    });
    rgb.r = new g.CSSMathSum(g.CSS.percent(10), g.CSS.percent(20));
    return {
      globals: [
        "CSSColorValue",
        "CSSRGB",
        "CSSHSL",
        "CSSHWB",
        "CSSLab",
        "CSSLCH",
        "CSSOKLab",
        "CSSOKLCH",
        "CSSColor",
      ].map((name) => typeof g[name]),
      prototypeChain: [rgb instanceof g.CSSColorValue, rgb instanceof g.CSSStyleValue],
      rgb: [rgb.r.constructor.name, channel(rgb.g), channel(rgb.b), channel(rgb.alpha)],
      hsl: [
        hsl.h.constructor.name,
        hsl.h.value,
        channel(hsl.s),
        channel(hsl.l),
        channel(hsl.alpha),
      ],
      hwb: [channel(hwb.h), channel(hwb.w), channel(hwb.b), channel(hwb.alpha)],
      lab: [channel(lab.l), channel(lab.a), channel(lab.b), channel(lab.alpha)],
      lch: [channel(lch.l), channel(lch.c), channel(lch.h), channel(lch.alpha)],
      oklab: [channel(oklab.l), channel(oklab.a), channel(oklab.b), channel(oklab.alpha)],
      oklch: [channel(oklch.l), channel(oklch.c), channel(oklch.h), channel(oklch.alpha)],
      color: {
        colorSpace: [color.colorSpace.constructor.name, color.colorSpace.value],
        channels: color.channels.map(channel),
        alpha: channel(color.alpha),
        sameChannels: originalChannels === color.channels,
        serialized: serializedColor,
        backingWriteRejected,
        cloneIndependent,
      },
      parsed: parsed.map((color: any) => [color.constructor.name, String(color)]),
      errors,
      parseErrors,
      accessors: ["l", "a", "b", "alpha"].map((name) =>
        Object.prototype.hasOwnProperty.call(g.CSSLab.prototype, name),
      ),
    };
  });
  expect(result).toEqual({
    globals: Array(9).fill("function"),
    prototypeChain: [true, true],
    rgb: [
      "CSSMathSum",
      ["CSSUnitValue", 73, "number"],
      ["CSSUnitValue", 91, "percent"],
      ["CSSUnitValue", 100, "percent"],
    ],
    hsl: [
      "CSSKeywordValue",
      "undefined",
      ["CSSUnitValue", 70, "percent"],
      ["CSSUnitValue", 91, "percent"],
      ["CSSUnitValue", 100, "percent"],
    ],
    hwb: [
      ["CSSUnitValue", 101, "grad"],
      ["CSSUnitValue", 20, "percent"],
      ["CSSUnitValue", 30, "percent"],
      ["CSSUnitValue", 0.4, "percent"],
    ],
    lab: [
      ["CSSUnitValue", 20, "percent"],
      ["CSSUnitValue", 7, "number"],
      ["CSSUnitValue", 8, "number"],
      ["CSSUnitValue", 0.4, "percent"],
    ],
    lch: [
      ["CSSUnitValue", 27, "percent"],
      ["CSSUnitValue", 70, "percent"],
      ["CSSUnitValue", 8, "deg"],
      ["CSSUnitValue", 100, "percent"],
    ],
    oklab: [
      ["CSSUnitValue", 27, "percent"],
      ["CSSUnitValue", 7, "number"],
      ["CSSUnitValue", 8, "number"],
      ["CSSUnitValue", 100, "percent"],
    ],
    oklch: [
      ["CSSUnitValue", 20, "percent"],
      ["CSSUnitValue", 70, "percent"],
      ["CSSUnitValue", 8, "rad"],
      ["CSSUnitValue", 0.4, "percent"],
    ],
    color: {
      colorSpace: ["CSSKeywordValue", "display-p3"],
      channels: [
        ["CSSUnitValue", 60, "percent"],
        ["CSSUnitValue", 70, "percent"],
        ["CSSUnitValue", 80, "percent"],
      ],
      alpha: ["CSSUnitValue", 0.5, "number"],
      sameChannels: true,
      serialized: "color(display-p3 40% 20% none / 0.5)",
      backingWriteRejected: true,
      cloneIndependent: true,
    },
    parsed: [
      ["CSSRGB", "rgb(0 191 255)"],
      ["CSSHSL", "hsl(123deg 100% 20% / 50%)"],
      ["CSSHWB", "hwb(200deg 31% 38% / 50%)"],
      ["CSSRGB", "rgb(0 0 255)"],
      ["CSSRGB", "rgb(0 0 0 / 0%)"],
      ["CSSKeywordValue", "graytext"],
    ],
    errors: [
      "SyntaxError",
      "SyntaxError",
      "SyntaxError",
      "TypeError",
      "SyntaxError",
      "SyntaxError",
      "SyntaxError",
      "SyntaxError",
      "SyntaxError",
      "TypeError",
      "SyntaxError",
      "SyntaxError",
    ],
    parseErrors: Array(5).fill("SyntaxError"),
    accessors: [true, true, true, true],
  });
});
