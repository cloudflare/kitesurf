// Copyright (c) 2026 Cloudflare, Inc.
// Modifications are licensed under the MIT License; see LICENSE.
// Copyright (c) 2024 Yuta Saito.
// Licensed under the MIT License; see LICENSE.

use std::collections::HashSet;

use anyhow::{Context, Result};
use replace::replace_funcs;

mod call_graph;
mod replace;

pub struct Tracee {
    pub name: String,
    pub hook_points: HashSet<HookPoint>,
}

pub fn allocator_tracees() -> Vec<Tracee> {
    vec![
        Tracee {
            name: "malloc".to_string(),
            hook_points: [HookPoint::Post].into(),
        },
        Tracee {
            name: "dlmalloc".to_string(),
            hook_points: [HookPoint::Post].into(),
        },
        Tracee {
            name: "free".to_string(),
            hook_points: [HookPoint::Post].into(),
        },
        Tracee {
            name: "dlfree".to_string(),
            hook_points: [HookPoint::Post].into(),
        },
        Tracee {
            name: "calloc".to_string(),
            hook_points: [HookPoint::Post].into(),
        },
        Tracee {
            name: "dlcalloc".to_string(),
            hook_points: [HookPoint::Post].into(),
        },
        Tracee {
            name: "realloc".to_string(),
            hook_points: [HookPoint::Post].into(),
        },
        Tracee {
            name: "dlrealloc".to_string(),
            hook_points: [HookPoint::Post].into(),
        },
        Tracee {
            name: "posix_memalign".to_string(),
            hook_points: [HookPoint::Post].into(),
        },
        Tracee {
            name: "dlposix_memalign".to_string(),
            hook_points: [HookPoint::Post].into(),
        },
        Tracee {
            name: "aligned_alloc".to_string(),
            hook_points: [HookPoint::Post].into(),
        },
        Tracee {
            name: "dlaligned_alloc".to_string(),
            hook_points: [HookPoint::Post].into(),
        },
    ]
}

pub fn instrument(input: Vec<u8>, tracees: &[Tracee]) -> Result<Vec<u8>> {
    log::info!("Initial parsing");
    let mut config = walrus::ModuleConfig::default();
    // config.generate_dwarf(true);
    config.generate_name_section(true);
    let mut m = walrus::Module::from_buffer_with_config(&input, &config)
        .with_context(|| "Failed to parse the input wasm module")?;

    log::info!("Building call graph");
    let mut call_graph = call_graph::CallGraph::build_from(&m);

    let mut replace_map = std::collections::HashMap::new();
    for tracee in tracees {
        log::info!("Finding function {}", tracee.name);
        let func = m.functions().find(|f| {
            f.name
                .as_ref()
                .map(|n| n.as_str() == tracee.name)
                .unwrap_or(false)
        });

        if let Some(func) = func {
            log::info!("Instrumenting function {}", tracee.name);
            let tracee_id = func.id();
            let hook = hook_function(&mut m, tracee_id, &tracee.name, &tracee.hook_points);
            replace_map.insert(tracee_id, hook);
        }
    }
    log::info!("Replacing functions");
    replace_funcs(&replace_map, &mut m, &mut call_graph);

    log::info!("Emitting wasm");
    Ok(m.emit_wasm())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HookPoint {
    Pre,
    Post,
}

fn hook_function(
    m: &mut walrus::Module,
    func_id: walrus::FunctionId,
    tracee_name: &str,
    hook_points: &HashSet<HookPoint>,
) -> walrus::FunctionId {
    let func = match &m.funcs.get(func_id).kind {
        walrus::FunctionKind::Local(f) => f,
        _ => panic!("hook_function called with an imported function"),
    };
    let params = m.types.params(func.ty()).to_vec();
    let results = m.types.results(func.ty()).to_vec();

    let mut new_func = walrus::FunctionBuilder::new(&mut m.types, &params, &results);
    new_func.name(format!("hooked_{}", tracee_name));
    let arg_locals = params
        .iter()
        .map(|ty| m.locals.add(*ty))
        .collect::<Vec<_>>();

    let mut body = new_func.func_body();
    if hook_points.contains(&HookPoint::Pre) {
        let user_prehook_ty = m.types.add(&params, &[]);
        let (user_prehook, _) = m.add_import_func(
            "wmprof",
            &format!("prehook_{}", tracee_name),
            user_prehook_ty,
        );

        // Forward all arguments to user prehook
        for local in arg_locals.iter() {
            body.local_get(*local);
        }
        body.call(user_prehook);
    }
    // Call the original function
    for local in arg_locals.iter() {
        body.local_get(*local);
    }
    body.call(func_id);
    if hook_points.contains(&HookPoint::Post) {
        let user_posthook_ty = m
            .types
            .add([params.clone(), results.clone()].concat().as_slice(), &[]);
        let (user_posthook, _) = m.add_import_func(
            "wmprof",
            &format!("posthook_{}", tracee_name),
            user_posthook_ty,
        );
        let result_locals = results
            .iter()
            .rev()
            .map(|ty| m.locals.add(*ty))
            .collect::<Vec<_>>();
        // Save the results of the original function to locals
        for local in result_locals.iter() {
            body.local_set(*local);
        }
        // Forward all arguments and results to user posthook
        for local in arg_locals.iter() {
            body.local_get(*local);
        }
        for local in result_locals.iter().rev() {
            body.local_get(*local);
        }
        body.call(user_posthook);
        // Restore the results of the original function from locals
        for local in result_locals.iter().rev() {
            body.local_get(*local);
        }
    }
    body.return_();
    new_func.finish(arg_locals, &mut m.funcs)
}

pub struct LocationInfo {
    pub line: u64,
}

pub struct FunctionInfo {}
