// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use std::cell::Cell;

use boa_engine::{
    js_string, module::set_live_resolve_hook, Context, JsObject, JsString, JsValue, Module,
};

thread_local! {
    static LIVE_VALUE: Cell<u8> = const { Cell::new(0) };
}

fn resolve_live_binding_to_sentinel(
    _namespace: f64,
    _raw_value_handle: u64,
    _name: &JsString,
    _cached_value: Option<JsValue>,
    _context: &mut Context,
) -> JsValue {
    js_string!("resolved live binding").into()
}

fn resolve_live_binding_from_test_state(
    _namespace: f64,
    _raw_value_handle: u64,
    _name: &JsString,
    cached_value: Option<JsValue>,
    context: &mut Context,
) -> JsValue {
    match LIVE_VALUE.with(Cell::get) {
        0 => JsValue::undefined(),
        1 => js_string!("first").into(),
        2 => js_string!("second").into(),
        _ => cached_value
            .filter(|value| value.as_object().is_some())
            .unwrap_or_else(|| {
                boa_engine::object::builtins::JsPromise::resolve(JsValue::undefined(), context)
                    .unwrap()
                    .into()
            }),
    }
}

fn resolve_live_binding_to_fresh_promise(
    _namespace: f64,
    _raw_value_handle: u64,
    _name: &JsString,
    cached_value: Option<JsValue>,
    context: &mut Context,
) -> JsValue {
    if let Some(cached) = cached_value {
        return cached;
    }
    boa_engine::object::builtins::JsPromise::resolve(JsValue::undefined(), context)
        .unwrap()
        .into()
}

fn assert_evaluated(module: &Module, context: &mut Context) {
    let evaluation = module.load_link_evaluate(context);
    context.run_jobs().unwrap();
    assert!(
        evaluation.state().as_fulfilled().is_some(),
        "module failed to evaluate: {:?}",
        evaluation.state()
    );
}

fn evaluate_default_module(value: JsValue, context: &mut Context) -> Module {
    let module = Module::from_value_as_default(value, context);
    assert_evaluated(&module, context);
    module
}

fn evaluate_p_export_module(value: JsValue, context: &mut Context) -> Module {
    let export_name = js_string!("p");
    let module = Module::synthetic(
        std::slice::from_ref(&export_name),
        boa_engine::module::SyntheticModuleInitializer::from_copy_closure_with_captures(
            |module, value: &JsValue, _context| module.set_export(&js_string!("p"), value.clone()),
            value,
        ),
        None,
        None,
        context,
    );
    assert_evaluated(&module, context);
    module
}

fn evaluate_source_module(source: &str, context: &mut Context) -> Module {
    let module = Module::parse(boa_engine::Source::from_bytes(source), None, context).unwrap();
    assert_evaluated(&module, context);
    module
}

fn call_reader(module: &Module, context: &mut Context) -> JsValue {
    module
        .get_value(js_string!("read"), context)
        .unwrap()
        .as_object()
        .expect("reader export should be a function")
        .call(&JsValue::undefined(), &[], context)
        .unwrap()
}

fn assert_live_value(value: &JsValue, expected: Option<&str>) {
    if let Some(expected) = expected {
        let expected: JsValue = JsString::from(expected).into();
        assert!(
            JsValue::same_value(value, &expected),
            "expected {expected:?}, got {value:?}"
        );
    } else {
        assert!(value.is_undefined(), "expected undefined, got {value:?}");
    }
}

fn register_namespace(module: &Module, context: &mut Context) {
    let namespace = module.namespace(context);
    context
        .register_global_property(
            js_string!("ns"),
            namespace,
            boa_engine::property::Attribute::all(),
        )
        .unwrap();
}

fn context_with_loader() -> (std::rc::Rc<boa_engine::module::MapModuleLoader>, Context) {
    let loader = std::rc::Rc::new(boa_engine::module::MapModuleLoader::new());
    let context = Context::builder()
        .module_loader(loader.clone())
        .build()
        .unwrap();
    (loader, context)
}

#[test]
fn ordinary_module_export_with_live_marker_shape_is_preserved() {
    set_live_resolve_hook(resolve_live_binding_to_sentinel);

    let mut context = Context::default();
    let object = JsObject::with_null_proto();
    object
        .create_data_property_or_throw(js_string!("__ks_live_ns"), 1.0, &mut context)
        .unwrap();
    object
        .create_data_property_or_throw(
            js_string!("__ks_live_name"),
            js_string!("default"),
            &mut context,
        )
        .unwrap();
    let original = JsValue::from(object);
    let exported = evaluate_default_module(original.clone(), &mut context)
        .get_value(js_string!("default"), &mut context)
        .unwrap();
    assert!(JsValue::same_value(&exported, &original));
}

#[test]
fn live_binding_marker_reads_each_host_update() {
    set_live_resolve_hook(resolve_live_binding_from_test_state);

    let mut context = Context::default();
    let module = evaluate_default_module(
        boa_engine::module::make_live_binding(1.0, js_string!("default"), 0),
        &mut context,
    );

    for (state, expected) in [(0, None), (1, Some("first")), (2, Some("second"))] {
        LIVE_VALUE.with(|value| value.set(state));
        let value = module
            .get_value(js_string!("default"), &mut context)
            .unwrap();
        assert_live_value(&value, expected);
    }
}

#[test]
fn namespace_reflection_reads_resolved_live_bindings() {
    set_live_resolve_hook(resolve_live_binding_to_sentinel);

    let mut context = Context::default();
    let module = evaluate_default_module(
        boa_engine::module::make_live_binding(1.0, js_string!("default"), 0),
        &mut context,
    );
    register_namespace(&module, &mut context);

    let reflected = context
        .eval(boa_engine::Source::from_bytes(
            "[Object.entries(ns)[0][1], Object.getOwnPropertyDescriptor(ns, 'default').value].join('|')",
        ))
        .unwrap();
    let expected: JsValue = js_string!("resolved live binding|resolved live binding").into();
    assert!(JsValue::same_value(&reflected, &expected));
}

#[test]
fn imported_live_bindings_resolve_bare_names_and_closures() {
    const DIRECT_IMPORTER: &str = concat!(
        "import { default as live } from '/dep.js';\n",
        "export const bare = live;\n",
        "export function read() { return live; }\n",
    );
    const REEXPORTED_IMPORTER: &str = concat!(
        "import { live } from '/reexport.js';\n",
        "export const bare = live;\n",
        "export function read() { return live; }\n",
    );
    const DIRECT_IDENTITY_IMPORTER: &str = concat!(
        "import { default as live } from '/dep.js';\n",
        "export const same = live === live;\n",
    );
    const REEXPORTED_IDENTITY_IMPORTER: &str = concat!(
        "import { live } from '/reexport.js';\n",
        "export const same = live === live;\n",
    );

    set_live_resolve_hook(resolve_live_binding_from_test_state);
    LIVE_VALUE.with(|value| value.set(0));

    let (loader, mut context) = context_with_loader();
    let dependency = evaluate_default_module(
        boa_engine::module::make_live_binding(1.0, js_string!("default"), 0),
        &mut context,
    );
    loader.insert("/dep.js", dependency);
    let reexporter = Module::parse(
        boa_engine::Source::from_bytes("export { default as live } from '/dep.js';"),
        None,
        &mut context,
    )
    .unwrap();
    loader.insert("/reexport.js", reexporter);

    let direct_closure = evaluate_source_module(DIRECT_IMPORTER, &mut context);
    let reexported_closure = evaluate_source_module(REEXPORTED_IMPORTER, &mut context);

    for (state, expected) in [(0, None), (1, Some("first")), (2, Some("second"))] {
        LIVE_VALUE.with(|value| value.set(state));

        let direct_bare = evaluate_source_module(DIRECT_IMPORTER, &mut context)
            .get_value(js_string!("bare"), &mut context)
            .unwrap();
        assert_live_value(&direct_bare, expected);
        assert_live_value(&call_reader(&direct_closure, &mut context), expected);

        let reexported_bare = evaluate_source_module(REEXPORTED_IMPORTER, &mut context)
            .get_value(js_string!("bare"), &mut context)
            .unwrap();
        assert_live_value(&reexported_bare, expected);
        assert_live_value(&call_reader(&reexported_closure, &mut context), expected);
    }

    LIVE_VALUE.with(|value| value.set(3));
    for source in [DIRECT_IDENTITY_IMPORTER, REEXPORTED_IDENTITY_IMPORTER] {
        let identity = evaluate_source_module(source, &mut context)
            .get_value(js_string!("same"), &mut context)
            .unwrap();
        assert_eq!(identity.as_boolean(), Some(true));
    }
    let direct_promise = call_reader(&direct_closure, &mut context);
    let reexported_promise = call_reader(&reexported_closure, &mut context);
    assert!(JsValue::same_value(&direct_promise, &reexported_promise));
}

#[test]
fn promise_export_identity_is_stable_for_namespace_and_imports() {
    set_live_resolve_hook(resolve_live_binding_to_fresh_promise);

    let (loader, mut context) = context_with_loader();
    let dependency = evaluate_p_export_module(
        boa_engine::module::make_live_binding(1.0, js_string!("p"), 0),
        &mut context,
    );
    register_namespace(&dependency, &mut context);

    let namespace_identity = context
        .eval(boa_engine::Source::from_bytes("ns.p === ns.p"))
        .unwrap();
    assert_eq!(namespace_identity.as_boolean(), Some(true));

    loader.insert("/dep.js", dependency);
    let importer = evaluate_source_module(
        "import { p } from '/dep.js'; export const same = p === p;",
        &mut context,
    );
    assert_eq!(
        importer
            .get_value(js_string!("same"), &mut context)
            .unwrap()
            .as_boolean(),
        Some(true)
    );
}
