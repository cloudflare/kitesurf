// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Differential tests (verified against V8) for indexed Array, TypedArray, and
//! String get/set fast paths in Boa.

use boa_engine::{Context, Source};

fn eval_json(src: &str) -> String {
    let mut ctx = Context::default();
    let val = ctx.eval(Source::from_bytes(src)).expect("eval succeeds");
    val.to_string(&mut ctx)
        .expect("to_string succeeds")
        .to_std_string_escaped()
}

#[test]
fn indexed_fastpaths_match_v8_oracle() {
    let cases: &[(&str, &str, &str)] = &[
        (
            "dense_i32_append_and_overwrite",
            r#"(() => {
              const a = [];
              for (let i = 0; i < 8; i++) a[i] = i * 3;
              a[2] = -7;
              return JSON.stringify([a.length, ...a]);
            })()"#,
            "[8,0,3,-7,9,12,15,18,21]",
        ),
        (
            "dense_f64_promotion_and_neg_zero",
            r#"(() => {
              const a = [];
              a[0] = 1;
              a[1] = -0;
              a[2] = 2.5;
              a[3] = NaN;
              return JSON.stringify([a.length, Object.is(a[1], -0), a[2], Number.isNaN(a[3])]);
            })()"#,
            "[4,true,2.5,true]",
        ),
        (
            "dense_element_promotion",
            r#"(() => {
              const a = [];
              a[0] = 1;
              a[1] = "hi";
              a[2] = { x: 9 };
              return JSON.stringify([a.length, a[0], a[1], a[2].x]);
            })()"#,
            r#"[3,1,"hi",9]"#,
        ),
        (
            "presized_array_preserves_length_and_holes",
            r#"(() => {
              const a = new Array(5);
              a[0] = 10;
              a[1] = 20;
              return JSON.stringify([a.length, a[0], a[1], 1 in a, 2 in a, a[2] === undefined]);
            })()"#,
            "[5,10,20,true,false,true]",
        ),
        (
            "sparse_write_past_dense_len",
            r#"(() => {
              const a = [];
              a[0] = 1;
              a[5] = 9;
              return JSON.stringify([a.length, a[0], 1 in a, 5 in a, a[5]]);
            })()"#,
            "[6,1,false,true,9]",
        ),
        (
            "non_extensible_array_strict_and_sloppy",
            r#"(() => {
              const a = Object.preventExtensions([10]);
              a[0] = 20;
              a[1] = 30;
              let threw = false;
              try { (function() { "use strict"; a[1] = 40; })(); } catch (e) { threw = e instanceof TypeError; }
              return JSON.stringify([a.length, a[0], 1 in a, threw]);
            })()"#,
            "[1,20,false,true]",
        ),
        (
            "non_writable_length_strict_and_sloppy",
            r#"(() => {
              const a = [1];
              Object.defineProperty(a, "length", { writable: false });
              a[0] = 2;
              a[1] = 3;
              let threw = false;
              try { (function() { "use strict"; a[1] = 4; })(); } catch (e) { threw = e instanceof TypeError; }
              return JSON.stringify([a.length, a[0], 1 in a, threw]);
            })()"#,
            "[1,2,false,true]",
        ),
        (
            "array_prototype_setter_intercepts_append",
            r#"(() => {
              let seen = -1;
              Object.defineProperty(Array.prototype, 0, {
                configurable: true,
                set(v) { seen = v; },
                get() { return 77; },
              });
              const a = [];
              a[0] = 42;
              return JSON.stringify([seen, a.length, Object.hasOwn(a, 0), a[0]]);
            })()"#,
            "[42,0,false,77]",
        ),
        (
            "array_prototype_readonly_blocks_append",
            r#"(() => {
              Object.defineProperty(Array.prototype, 0, {
                configurable: true,
                value: 99,
                writable: false,
              });
              const a = [];
              a[0] = 42;
              let threw = false;
              try { (function() { "use strict"; a[0] = 42; })(); } catch (e) { threw = e instanceof TypeError; }
              return JSON.stringify([a.length, Object.hasOwn(a, 0), a[0], threw]);
            })()"#,
            "[0,false,99,true]",
        ),
        (
            "object_prototype_setter_intercepts_append",
            r#"(() => {
              let seen = -1;
              Object.defineProperty(Object.prototype, 1, {
                configurable: true,
                set(v) { seen = v; },
                get() { return 88; },
              });
              const a = [];
              a[0] = 1;
              a[1] = 2;
              return JSON.stringify([seen, a.length, Object.hasOwn(a, 0), Object.hasOwn(a, 1)]);
            })()"#,
            "[2,1,true,false]",
        ),
        (
            "proxy_in_prototype_chain_intercepts_append",
            r#"(() => {
              let seen = "";
              const p = new Proxy({}, {
                set(t, k, v) { seen = String(k) + ":" + v; return true; },
              });
              Object.setPrototypeOf(Array.prototype, p);
              const a = [];
              a[0] = 5;
              return JSON.stringify([seen, a.length, Object.hasOwn(a, 0)]);
            })()"#,
            r#"["0:5",0,false]"#,
        ),
        (
            "super_index_write_targets_receiver",
            r#"(() => {
              const base = [10, 20];
              const child = {
                __proto__: base,
                writeExisting() { super[0] = 99; },
                writeAppend() { super[2] = 30; },
              };
              child.writeExisting();
              child.writeAppend();
              return JSON.stringify([base[0], base.length, child[0], child[2], Object.hasOwn(child, 0)]);
            })()"#,
            "[10,2,99,30,true]",
        ),
        (
            "string_index_in_and_out_of_bounds",
            r#"(() => {
              Object.defineProperty(String.prototype, 5, { configurable: true, value: "Z" });
              const s = "abc";
              return JSON.stringify([s[0], s[2], s[3] === undefined, s[5]]);
            })()"#,
            r#"["a","c",true,"Z"]"#,
        ),
        (
            "typed_array_all_numeric_kinds_and_wrapping",
            r#"(() => {
              const u8 = new Uint8Array(3);
              u8[0] = 257; u8[1] = -1; u8[2] = 42; u8[3] = 9;
              const i8 = new Int8Array(2);
              i8[0] = 128; i8[1] = -129;
              const uc = new Uint8ClampedArray(3);
              uc[0] = -5; uc[1] = 300; uc[2] = 2.5;
              const f64 = new Float64Array(2);
              f64[0] = -0; f64[1] = 1.25;
              const bi = new BigInt64Array(2);
              bi[0] = 5n; bi[1] = -3n;
              return JSON.stringify([
                u8[0], u8[1], u8[2], u8[3] === undefined,
                i8[0], i8[1],
                uc[0], uc[1], uc[2],
                Object.is(f64[0], -0), f64[1],
                String(bi[0]), String(bi[1]),
              ]);
            })()"#,
            r#"[1,255,42,true,-128,127,0,255,2,true,1.25,"5","-3"]"#,
        ),
        (
            "typed_array_strict_oob_and_valueof_order",
            r#"(() => {
              "use strict";
              const u8 = new Uint8Array(2);
              let calls = 0;
              u8[5] = { valueOf() { calls++; return 7; } };
              let threw = false;
              try { u8[0] = { valueOf() { throw new RangeError("boom"); } }; }
              catch (e) { threw = e instanceof RangeError; }
              return JSON.stringify([calls, threw, u8[0], u8[5] === undefined]);
            })()"#,
            "[1,true,0,true]",
        ),
    ];

    for &(name, src, expected) in cases {
        assert_eq!(eval_json(src), expected, "oracle mismatch on {name}");
    }
}

#[test]
fn inline_cache_and_ordinary_get_match_v8_oracle() {
    let cases: &[(&str, &str, &str)] = &[
        (
            "ic_getter_and_data_transition",
            r#"(() => {
              function read(o) { return o.x; }
              const a = { x: 1 };
              const b = { x: 2 };
              const r1 = read(a), r2 = read(b);
              Object.defineProperty(a, "x", { get() { return 99; } });
              const r3 = read(a), r4 = read(b);
              delete b.x;
              const r5 = read(b);
              return JSON.stringify([r1, r2, r3, r4, r5 === undefined]);
            })()"#,
            "[1,2,99,2,true]",
        ),
        (
            "ic_prototype_getter_and_undefined_getter",
            r#"(() => {
              function read(o) { return o.p; }
              const proto = {};
              Object.defineProperty(proto, "p", { get() { return this.v * 2; }, configurable: true });
              const a = Object.create(proto); a.v = 5;
              const b = Object.create(proto); b.v = 8;
              const r1 = read(a), r2 = read(b);
              const proto2 = {};
              Object.defineProperty(proto2, "p", { set(_) {} });
              const c = Object.create(proto2);
              const r3 = read(c);
              return JSON.stringify([r1, r2, r3 === undefined]);
            })()"#,
            "[10,16,true]",
        ),
        (
            "deep_proto_chain_and_proxy_proto",
            r#"(() => {
              const p3 = new Proxy({}, { get(t, k, r) { return k === "deep" ? "hit:" + r.tag : undefined; } });
              const p2 = Object.create(p3);
              p2.mid = 42;
              const p1 = Object.create(p2);
              const leaf = Object.create(p1);
              leaf.tag = "ok";
              return JSON.stringify([leaf.mid, leaf.deep, leaf.missing === undefined]);
            })()"#,
            r#"[42,"hit:ok",true]"#,
        ),
        (
            "sparse_indexed_accessor_receiver",
            r#"(() => {
              const a = [];
              a.tag = 7;
              Object.defineProperty(a, 10000, { get() { return this.tag * 3; } });
              const child = Object.create(a);
              child.tag = 11;
              return JSON.stringify([a[10000], child[10000]]);
            })()"#,
            "[21,33]",
        ),
        (
            "megamorphic_ic_reads_and_writes",
            r#"(() => {
              function read(o) { return o.k; }
              function write(o, v) { o.k = v; }
              const objs = [
                { k: 1 },
                { a: 0, k: 2 },
                { b: 0, k: 3 },
                { c: 0, k: 4 },
                { d: 0, k: 5 },
                { e: 0, get k() { return this._k || 6; }, set k(v) { this._k = v * 10; } },
              ];
              const before = objs.map(read);
              objs.forEach((o, i) => write(o, i + 10));
              const after = objs.map(read);
              return JSON.stringify([before, after]);
            })()"#,
            "[[1,2,3,4,5,6],[10,11,12,13,14,150]]",
        ),
        (
            "by_value_string_key_fastpath_and_edge_cases",
            r#"(() => {
              const o = { foo: 10, bar: 20, "": 30 };
              const kFoo = "foo", kBar = "bar", kEmpty = "", kZero = "0", kLen = "length";
              o[kFoo] = 11;
              o[kEmpty] = 31;
              Object.defineProperty(o, "ro", { value: 99, writable: false });
              o["ro"] = 100;
              let strictRoThrew = false;
              try { (function() { "use strict"; o["ro"] = 100; })(); } catch (e) { strictRoThrew = e instanceof TypeError; }
              let getterCalls = 0, setterVal = 0;
              Object.defineProperty(o, "acc", {
                get() { getterCalls++; return 77; },
                set(v) { setterVal = v; }
              });
              const accRead = o["acc"];
              o["acc"] = 88;
              const arr = [100, 200, 300];
              const a0 = arr[kZero];
              const aLenBefore = arr[kLen];
              arr[kLen] = 1;
              const aLenAfter = arr.length;
              const proto = { inherited: 55 };
              const child = Object.create(proto);
              child.own = 44;
              const p = new Proxy({ foo: 1 }, { get: () => 555 });
              return JSON.stringify([
                o[kFoo], o[kBar], o[kEmpty], o["ro"], strictRoThrew,
                accRead, getterCalls, setterVal,
                a0, aLenBefore, aLenAfter, arr[1] === undefined,
                child["own"], child["inherited"], p[kFoo]
              ]);
            })()"#,
            "[11,20,31,99,true,77,1,88,100,3,1,true,44,55,555]",
        ),
        (
            "megamorphic_cache_readonly_and_array_length_safety",
            r#"(() => {
              function getLen(o) { return o.length; }
              function setLen(o, v) { o.length = v; }
              function setLenStrict(o, v) { "use strict"; o.length = v; }
              const shapes = [
                { a: 1, length: 1 },
                { b: 1, length: 2 },
                { c: 1, length: 3 },
                { d: 1, length: 4 },
                { e: 1, length: 5 },
              ];
              const ro = { f: 1 };
              Object.defineProperty(ro, "length", { value: 42, writable: false });
              const arr = [10, 20, 30];
              for (const s of shapes) { getLen(s); setLen(s, 9); }
              const roRead = getLen(ro);
              setLen(ro, 100);
              let threw = false;
              try { setLenStrict(ro, 100); } catch (e) { threw = e instanceof TypeError; }
              const arrLenBefore = getLen(arr);
              setLen(arr, 1);
              return JSON.stringify([roRead, ro.length, threw, arrLenBefore, arr.length, arr[1] === undefined]);
            })()"#,
            "[42,42,true,3,1,true]",
        ),
    ];

    for &(name, src, expected) in cases {
        assert_eq!(eval_json(src), expected, "oracle mismatch on {name}");
    }
}

#[test]
fn ordinary_set_and_rope_strings_match_v8_oracle() {
    let cases: &[(&str, &str, &str)] = &[
        (
            "ordinary_set_own_and_new_and_proto",
            r#"(() => {
              const o = { a: 1 };
              o.a = 2;
              o.b = 3;
              Object.defineProperty(o, "ro", { value: 10, writable: false });
              o.ro = 20;
              let roThrew = false;
              try { (function() { "use strict"; o.ro = 20; })(); } catch (e) { roThrew = e instanceof TypeError; }
              let setterVal = 0;
              Object.defineProperty(o, "acc", { set(v) { setterVal = v; } });
              o.acc = 42;
              Object.defineProperty(o, "getOnly", { get() { return 5; } });
              let goThrew = false;
              try { (function() { "use strict"; o.getOnly = 9; })(); } catch (e) { goThrew = e instanceof TypeError; }
              const sealed = Object.preventExtensions({ x: 1 });
              sealed.x = 2;
              sealed.y = 3;
              let neThrew = false;
              try { (function() { "use strict"; sealed.y = 4; })(); } catch (e) { neThrew = e instanceof TypeError; }
              let protoSet = 0;
              const proto = {};
              Object.defineProperty(proto, "p", { set(v) { protoSet = v; } });
              Object.defineProperty(proto, "pro", { value: 7, writable: false });
              const child = Object.create(proto);
              child.p = 99;
              child.pro = 88;
              const sparse = [];
              sparse[1000] = 1;
              sparse[1000] = 2;
              Object.defineProperty(sparse, 2000, { value: 5, writable: false });
              sparse[2000] = 6;
              return JSON.stringify([o.a, o.b, o.ro, roThrew, setterVal, goThrew, sealed.x, "y" in sealed, neThrew, protoSet, "p" in child, Object.hasOwn(child, "p"), child.pro, sparse[1000], sparse[2000]]);
            })()"#,
            "[2,3,10,true,42,true,2,false,true,99,true,false,7,2,5]",
        ),
        (
            "rope_concat_template_unicode_and_key",
            r#"(() => {
              let s = "";
              for (let i = 0; i < 2000; i++) s += (i % 2 === 0 ? "ab" : "cd");
              let t = "";
              for (let i = 0; i < 200; i++) t = `${t}${i},`;
              const u = "x".repeat(80) + "🚀" + "y".repeat(80);
              const map = {};
              const k = "prefix_".repeat(12) + "end";
              map[k] = 123;
              const k2 = ("prefix_".repeat(12)) + ("e" + "nd");
              return JSON.stringify([s.length, s.slice(0, 8), s[3999], t.length, t.startsWith("0,1,2,"), u.length, u.indexOf("🚀"), map[k2]]);
            })()"#,
            r#"[4000,"abcdabcd","d",690,true,162,80,123]"#,
        ),
        (
            "megamorphic_by_name_and_by_value_and_dense_append",
            r#"(() => {
              const objs = [];
              for (let i = 0; i < 12; i++) {
                const o = {};
                o["p" + i] = i;
                o.v = i * 3;
                objs.push(o);
              }
              let sum = 0;
              const key = "v";
              for (let r = 0; r < 5; r++) {
                for (let i = 0; i < objs.length; i++) {
                  objs[i][key] = objs[i][key] + 1;
                  sum += objs[i].v;
                }
              }
              const arr = [];
              for (let i = 0; i < 64; i++) arr[i] = i;
              return JSON.stringify([sum, arr.length, arr[0], arr[63]]);
            })()"#,
            "[1170,64,0,63]",
        ),
    ];

    for &(name, src, expected) in cases {
        assert_eq!(eval_json(src), expected, "oracle mismatch on {name}");
    }
}

#[test]
fn rope_concat_handles_utf16_static_string() {
    use boa_engine::JsString;
    use boa_engine::string::{JsStr, StaticString};

    static UTF16_STATIC: StaticString = StaticString::new(JsStr::utf16(&[0x3042, 0x3044]));
    let s_utf16 = JsString::from_static(&UTF16_STATIC);
    let pad = JsString::from("a".repeat(80).as_str());
    let combined = JsString::concat_owned(pad, s_utf16);
    assert_eq!(
        combined.to_std_string_escaped(),
        format!("{}\u{3042}\u{3044}", "a".repeat(80))
    );

    // Tiny-chunk += loops compact geometrically instead of retaining one node per char.
    let mut tiny = JsString::from("x".repeat(64).as_str());
    for _ in 0..5000 {
        tiny = JsString::concat_owned(tiny, JsString::from("y"));
    }
    assert_eq!(tiny.len(), 5064);
    assert_eq!(
        tiny.to_std_string_escaped(),
        format!("{}{}", "x".repeat(64), "y".repeat(5000))
    );
}
