// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use proc_macro2::{Span, TokenStream, TokenTree};
use std::collections::HashSet;
use std::env;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    Attribute, Block, Expr, ExprClosure, ExprIf, ForeignItem, ImplItem, Item, Meta,
    Path as SynPath, Token, TraitItem,
};

const MAX_SOURCE_BYTES: usize = 8 * 1024 * 1024;
const NESTING_LINT_PATH: &[&str] = &["clippy", "excessive_nesting"];
const NESTING_EXCEPTION_ERROR: &str =
    "function exception must be exactly #[allow(clippy::excessive_nesting, reason = \"nonempty rationale\")]";
const NESTING_SCOPE_ERROR: &str =
    "clippy::excessive_nesting exceptions are supported only on function declarations";
const USAGE: &str = "Usage: rust-control-flow-nesting --max-depth <N> <authored.rs>...\n\
Checks Rust control-flow nesting within each function. Macro token bodies are not inspected.";

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct Position {
    line: usize,
    column: usize,
}

impl Position {
    fn from_span(span: Span) -> Self {
        let start = span.start();
        Self {
            line: start.line,
            column: start.column + 1,
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
struct Finding {
    position: Position,
    message: String,
}

struct Config {
    max_depth: usize,
    files: Vec<PathBuf>,
}

fn main() -> ExitCode {
    let config = match parse_args(env::args_os().skip(1)) {
        Ok(Some(config)) => config,
        Ok(None) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            eprintln!("{error}\n{USAGE}");
            return ExitCode::from(2);
        }
    };

    run_check(config)
}

fn parse_args(
    args: impl IntoIterator<Item = std::ffi::OsString>,
) -> Result<Option<Config>, String> {
    let mut args = args.into_iter();
    let Some(first) = args.next() else {
        return Err("missing --max-depth and authored Rust file paths".to_owned());
    };
    let first = first
        .to_str()
        .ok_or_else(|| "command-line options must be valid UTF-8".to_owned())?;
    if first == "--help" || first == "-h" {
        return if args.next().is_none() {
            Ok(None)
        } else {
            Err("--help does not accept additional arguments".to_owned())
        };
    }
    if first != "--max-depth" {
        return Err("expected --max-depth <N> before the file paths".to_owned());
    }

    let max_depth = args
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or_else(|| "--max-depth requires a positive integer".to_owned())?
        .parse::<usize>()
        .map_err(|_| "--max-depth requires a positive integer".to_owned())?;
    if max_depth == 0 {
        return Err("--max-depth must be greater than zero".to_owned());
    }

    let files = args.map(PathBuf::from).collect::<Vec<_>>();
    if files.is_empty() {
        return Err("at least one authored Rust file path is required".to_owned());
    }

    Ok(Some(Config { max_depth, files }))
}

fn run_check(config: Config) -> ExitCode {
    let mut checked_files = 0;
    let mut violation_count = 0;
    let mut error_count = 0;

    for path in &config.files {
        let source = match read_source(path) {
            Ok(source) => source,
            Err(error) => {
                eprintln!("{}: could not read Rust source: {error}", path.display());
                error_count += 1;
                continue;
            }
        };
        let syntax = match syn::parse_file(&source) {
            Ok(syntax) => syntax,
            Err(error) => {
                let position = Position::from_span(error.span());
                eprintln!(
                    "{}:{}:{}: could not parse Rust source: {error}",
                    path.display(),
                    position.line,
                    position.column
                );
                error_count += 1;
                continue;
            }
        };

        checked_files += 1;
        let findings = analyze_file(&syntax, config.max_depth);
        for finding in findings {
            eprintln!(
                "{}:{}:{}: {}",
                path.display(),
                finding.position.line,
                finding.position.column,
                finding.message
            );
            violation_count += 1;
        }
    }

    println!(
        "Rust control-flow nesting: {checked_files}/{} authored files parsed, {violation_count} violations, {error_count} errors (macro token bodies are not inspected)",
        config.files.len()
    );

    if violation_count == 0 && error_count == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn read_source(path: &Path) -> io::Result<String> {
    let file = File::open(path)?;
    if file.metadata()?.len() > MAX_SOURCE_BYTES as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("source exceeds the {MAX_SOURCE_BYTES}-byte per-file limit"),
        ));
    }

    // syn builds a full AST, so cap each source before parsing and release it before the next file.
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("source exceeds the {MAX_SOURCE_BYTES}-byte per-file limit"),
        ));
    }

    String::from_utf8(bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn analyze_file(syntax: &syn::File, max_depth: usize) -> Vec<Finding> {
    let mut attribute_scanner = AllowAttributeScanner::default();
    attribute_scanner.visit_file(syntax);

    let mut analyzer = FileAnalyzer {
        max_depth,
        findings: Vec::new(),
        function_allow_positions: HashSet::new(),
    };
    for item in &syntax.items {
        analyzer.visit_item(item);
    }
    analyzer.report_non_function_exceptions(attribute_scanner.positions);
    analyzer.findings.sort_by_key(|finding| finding.position);
    analyzer.findings
}

#[derive(Default)]
struct AllowAttributeScanner {
    positions: Vec<Position>,
}

impl<'ast> Visit<'ast> for AllowAttributeScanner {
    fn visit_attribute(&mut self, attribute: &'ast Attribute) {
        if nesting_allow_is_valid_shape_or_targeted(attribute).is_some() {
            self.positions.push(Position::from_span(attribute.span()));
        }
        visit::visit_attribute(self, attribute);
    }
}

struct FileAnalyzer {
    max_depth: usize,
    findings: Vec<Finding>,
    function_allow_positions: HashSet<Position>,
}

impl FileAnalyzer {
    fn visit_item(&mut self, item: &Item) {
        match item {
            Item::Fn(function) => self.visit_function(&function.attrs, &function.block),
            Item::Mod(module) => {
                if let Some((_, items)) = &module.content {
                    for item in items {
                        self.visit_item(item);
                    }
                }
            }
            Item::Impl(implementation) => {
                for item in &implementation.items {
                    if let ImplItem::Fn(function) = item {
                        self.visit_function(&function.attrs, &function.block);
                    }
                }
            }
            Item::Trait(trait_item) => {
                for item in &trait_item.items {
                    if let TraitItem::Fn(function) = item {
                        if let Some(body) = &function.default {
                            self.visit_function(&function.attrs, body);
                        } else {
                            self.function_exception_is_allowed(&function.attrs);
                        }
                    }
                }
            }
            Item::ForeignMod(foreign_mod) => {
                for item in &foreign_mod.items {
                    if let ForeignItem::Fn(function) = item {
                        self.function_exception_is_allowed(&function.attrs);
                    }
                }
            }
            _ => {}
        }
    }

    fn visit_function(&mut self, attributes: &[Attribute], body: &Block) {
        let is_exempt = self.function_exception_is_allowed(attributes);
        let mut visitor = FunctionVisitor {
            analyzer: self,
            depth: 0,
            is_exempt,
        };
        visitor.visit_block(body);
    }

    fn function_exception_is_allowed(&mut self, attributes: &[Attribute]) -> bool {
        let mut targeted = Vec::new();
        for attribute in attributes {
            if let Some(is_valid) = nesting_allow_is_valid_shape_or_targeted(attribute) {
                self.function_allow_positions
                    .insert(Position::from_span(attribute.span()));
                targeted.push((attribute, is_valid));
            }
        }

        if targeted.is_empty() {
            return false;
        }
        if targeted.len() == 1 && targeted[0].1 {
            return true;
        }

        let message = if targeted.len() == 1 {
            NESTING_EXCEPTION_ERROR
        } else {
            "use one function-level excessive-nesting exception with a nonempty reason"
        };
        self.push_finding(targeted[0].0.span(), message);
        false
    }

    fn report_non_function_exceptions(&mut self, positions: Vec<Position>) {
        for position in positions {
            if !self.function_allow_positions.contains(&position) {
                self.findings.push(Finding {
                    position,
                    message: NESTING_SCOPE_ERROR.to_owned(),
                });
            }
        }
    }

    fn report_depth(&mut self, span: Span, depth: usize, is_exempt: bool) {
        if depth <= self.max_depth || is_exempt {
            return;
        }
        self.push_finding(
            span,
            &format!(
                "control-flow nesting depth {depth} exceeds maximum {}",
                self.max_depth
            ),
        );
    }

    fn push_finding(&mut self, span: Span, message: &str) {
        self.findings.push(Finding {
            position: Position::from_span(span),
            message: message.to_owned(),
        });
    }
}

fn nesting_allow_is_valid_shape_or_targeted(attribute: &Attribute) -> Option<bool> {
    if !attribute.path().is_ident("allow") {
        return None;
    }

    let metas = match attribute.parse_args_with(Punctuated::<Meta, Token![,]>::parse_terminated) {
        Ok(metas) => metas,
        Err(_) => {
            let Meta::List(list) = &attribute.meta else {
                return None;
            };
            return token_stream_has_lint_ident(&list.tokens).then_some(false);
        }
    };
    if !metas
        .iter()
        .any(|meta| path_is(meta_path(meta), NESTING_LINT_PATH))
    {
        return None;
    }

    let lint_count = metas
        .iter()
        .filter(|meta| matches!(meta, Meta::Path(path) if path_is(path, NESTING_LINT_PATH)))
        .count();
    let reason_count = metas.iter().filter(|meta| is_reason(meta)).count();
    let has_nonempty_reason = metas.iter().any(is_nonempty_reason);
    Some(metas.len() == 2 && lint_count == 1 && reason_count == 1 && has_nonempty_reason)
}

fn token_stream_has_lint_ident(tokens: &TokenStream) -> bool {
    tokens.clone().into_iter().any(|token| match token {
        TokenTree::Ident(ident) => ident == "excessive_nesting",
        TokenTree::Group(group) => token_stream_has_lint_ident(&group.stream()),
        TokenTree::Punct(_) | TokenTree::Literal(_) => false,
    })
}

fn meta_path(meta: &Meta) -> &SynPath {
    match meta {
        Meta::Path(path) => path,
        Meta::List(list) => &list.path,
        Meta::NameValue(name_value) => &name_value.path,
    }
}

fn path_is(path: &SynPath, segments: &[&str]) -> bool {
    path.leading_colon.is_none()
        && path.segments.len() == segments.len()
        && path
            .segments
            .iter()
            .zip(segments)
            .all(|(segment, expected)| {
                segment.ident == *expected && matches!(segment.arguments, syn::PathArguments::None)
            })
}

fn is_reason(meta: &Meta) -> bool {
    matches!(meta, Meta::NameValue(name_value) if path_is(&name_value.path, &["reason"]))
}

fn is_nonempty_reason(meta: &Meta) -> bool {
    let Meta::NameValue(name_value) = meta else {
        return false;
    };
    if !path_is(&name_value.path, &["reason"]) {
        return false;
    }
    let Expr::Lit(expression) = &name_value.value else {
        return false;
    };
    let syn::Lit::Str(reason) = &expression.lit else {
        return false;
    };
    !reason.value().trim().is_empty()
}

struct FunctionVisitor<'analyzer> {
    analyzer: &'analyzer mut FileAnalyzer,
    depth: usize,
    is_exempt: bool,
}

impl FunctionVisitor<'_> {
    fn with_depth(&mut self, depth: usize, visit: impl FnOnce(&mut Self)) {
        let previous_depth = self.depth;
        self.depth = depth;
        visit(self);
        self.depth = previous_depth;
    }

    fn visit_closure(&mut self, closure: &ExprClosure) {
        let mut visitor = FunctionVisitor {
            analyzer: self.analyzer,
            depth: 0,
            is_exempt: false,
        };
        visitor.visit_expr(&closure.body);
    }
}

impl<'ast> Visit<'ast> for FunctionVisitor<'_> {
    fn visit_expr_if(&mut self, expression: &'ast ExprIf) {
        let depth = self.depth.saturating_add(1);
        self.analyzer
            .report_depth(expression.span(), depth, self.is_exempt);
        self.with_depth(depth, |visitor| {
            visitor.visit_expr(&expression.cond);
            visitor.visit_block(&expression.then_branch);
        });

        if let Some((_, else_expression)) = &expression.else_branch {
            if matches!(else_expression.as_ref(), Expr::If(_)) {
                self.visit_expr(else_expression);
            } else {
                self.with_depth(depth, |visitor| visitor.visit_expr(else_expression));
            }
        }
    }

    fn visit_expr_match(&mut self, expression: &'ast syn::ExprMatch) {
        let depth = self.depth.saturating_add(1);
        self.analyzer
            .report_depth(expression.span(), depth, self.is_exempt);
        self.with_depth(depth, |visitor| {
            visit::visit_expr_match(visitor, expression)
        });
    }

    fn visit_expr_loop(&mut self, expression: &'ast syn::ExprLoop) {
        let depth = self.depth.saturating_add(1);
        self.analyzer
            .report_depth(expression.span(), depth, self.is_exempt);
        self.with_depth(depth, |visitor| visit::visit_expr_loop(visitor, expression));
    }

    fn visit_expr_for_loop(&mut self, expression: &'ast syn::ExprForLoop) {
        let depth = self.depth.saturating_add(1);
        self.analyzer
            .report_depth(expression.span(), depth, self.is_exempt);
        self.with_depth(depth, |visitor| {
            visit::visit_expr_for_loop(visitor, expression)
        });
    }

    fn visit_expr_while(&mut self, expression: &'ast syn::ExprWhile) {
        let depth = self.depth.saturating_add(1);
        self.analyzer
            .report_depth(expression.span(), depth, self.is_exempt);
        self.with_depth(depth, |visitor| {
            visit::visit_expr_while(visitor, expression)
        });
    }

    fn visit_expr_closure(&mut self, expression: &'ast ExprClosure) {
        self.visit_closure(expression);
    }

    fn visit_item(&mut self, item: &'ast Item) {
        self.analyzer.visit_item(item);
    }
}

#[cfg(test)]
mod tests {
    use super::{analyze_file, Finding};

    fn check(source: &str, max_depth: usize) -> Vec<Finding> {
        let syntax = syn::parse_file(source).expect("test Rust source should parse");
        analyze_file(&syntax, max_depth)
    }

    fn depth_messages(findings: &[Finding]) -> Vec<&str> {
        findings
            .iter()
            .filter(|finding| finding.message.starts_with("control-flow nesting depth"))
            .map(|finding| finding.message.as_str())
            .collect()
    }

    #[test]
    fn nesting_accepts_four_levels_and_reports_the_fifth() {
        let findings = check(
            r#"
            fn four(flag: bool) {
                if flag {
                    loop {
                        while flag {
                            match flag {
                                true => {},
                                false => {},
                            }
                        }
                    }
                }
            }

            fn five(flag: bool) {
                if flag {
                    loop {
                        while flag {
                            match flag {
                                true => if flag {},
                                false => {},
                            }
                        }
                    }
                }
            }
            "#,
            4,
        );

        assert_eq!(
            depth_messages(&findings),
            ["control-flow nesting depth 5 exceeds maximum 4"]
        );
        assert_eq!(findings[0].position.line, 20);
    }

    #[test]
    fn nesting_does_not_count_else_if_chains_as_extra_levels() {
        let findings = check(
            r#"
            fn chain(value: u8) {
                if value == 0 {
                } else if value == 1 {
                    if value == 2 {
                        if value == 3 {
                            if value == 4 {}
                        }
                    }
                } else if value == 5 {
                }
            }
            "#,
            4,
        );

        assert!(findings.is_empty());
    }

    #[test]
    fn nesting_counts_if_let_as_an_if_expression() {
        let findings = check(
            r#"
            fn nested(value: Option<bool>) {
                if let Some(flag) = value {
                    if flag {}
                }
            }
            "#,
            1,
        );

        assert_eq!(
            depth_messages(&findings),
            ["control-flow nesting depth 2 exceeds maximum 1"]
        );
    }

    #[test]
    fn nesting_ignores_impl_braces_and_let_else_blocks() {
        let findings = check(
            r#"
            struct Worker;
            impl Worker {
                fn first(&self) {
                    loop { break; }
                    loop { break; }
                    let Some(value) = Some(()) else { return; };
                    let _ = value;
                }

                fn second(&self, flag: bool) {
                    if flag {
                        let Some(value) = Some(()) else { return; };
                        let _ = value;
                    }
                }
            }
            "#,
            1,
        );

        assert!(findings.is_empty());
    }

    #[test]
    fn nesting_resets_for_nested_functions_and_closures() {
        let findings = check(
            r#"
            fn outer(flag: bool) {
                if flag {
                    loop {
                        while flag {
                            for _ in 0..1 {
                                fn nested(inner: bool) {
                                    if inner {
                                        loop {
                                            while inner {
                                                for _ in 0..1 {
                                                    if inner {}
                                                }
                                            }
                                        }
                                    }
                                }
                                let deep = || {
                                    if flag {
                                        loop {
                                            while flag {
                                                for _ in 0..1 {
                                                    if flag {}
                                                }
                                            }
                                        }
                                    }
                                };
                                let shallow = || if flag {};
                                let _ = (deep, shallow);
                            }
                        }
                    }
                }
            }
            "#,
            4,
        );

        assert_eq!(depth_messages(&findings).len(), 2);
        assert!(depth_messages(&findings)
            .iter()
            .all(|message| message.contains("depth 5")));
    }

    #[test]
    fn nesting_does_not_parse_strings_comments_or_macro_tokens() {
        let findings = check(
            r####"
            fn masked() {
                let ordinary = "if true { loop { match true { _ => {} } } }";
                let raw = r###"if true { if true { while true {} } }"###;
                // if true { loop { while true {} } }
                /* match true { _ => if true { loop { while true {} } } } */
                let tokens = stringify!(if true { if true { loop { while true {} } } });
                let _ = (ordinary, raw, tokens);
            }
            "####,
            1,
        );

        assert!(findings.is_empty());
    }

    #[test]
    fn nesting_skips_direct_global_const_expressions() {
        let findings = check(
            r#"
            const VALUE: bool = if true {
                if true { true } else { false }
            } else {
                false
            };
            "#,
            1,
        );

        assert!(findings.is_empty());
    }

    #[test]
    fn nesting_does_not_count_non_control_blocks() {
        let findings = check(
            r#"
            fn blocks(flag: bool) {
                { if flag { if flag {} } }
                unsafe { if flag { if flag {} } }
                let future = async { if flag { if flag {} } };
                let result: Result<(), ()> = try { if flag { if flag {} } };
                let _ = (future, result);
            }
            "#,
            1,
        );

        assert_eq!(depth_messages(&findings).len(), 4);
        assert!(depth_messages(&findings)
            .iter()
            .all(|message| message.contains("depth 2")));
    }

    #[test]
    fn nesting_does_not_count_struct_literal_braces() {
        let findings = check(
            r#"
            struct Record { value: bool }
            fn record(flag: bool) {
                let record = Record {
                    value: if flag { match flag { true => true, false => false } } else { false },
                };
                let _ = record;
            }
            "#,
            2,
        );

        assert!(findings.is_empty());
    }

    #[test]
    fn nesting_accepts_only_a_reasoned_function_level_exception() {
        let findings = check(
            r#"
            struct Callback;
            impl Callback {
                #[allow(clippy::excessive_nesting, reason = "FFI callback follows the protocol state machine")]
                fn handle(&self, flag: bool) {
                    if flag { loop { while flag { match flag { true => if flag {}, false => {} } } } }
                }
            }
            "#,
            4,
        );

        assert!(findings.is_empty());
    }

    #[test]
    fn nesting_function_exceptions_do_not_apply_to_nested_functions_or_closures() {
        let findings = check(
            r#"
            #[allow(clippy::excessive_nesting, reason = "outer protocol adapter is bounded")]
            fn outer(flag: bool) {
                fn nested(flag: bool) {
                    if flag { loop { while flag { for _ in 0..1 { match flag { _ => {} } } } } }
                }
                let callback = || {
                    if flag { loop { while flag { for _ in 0..1 { match flag { _ => {} } } } } }
                };
                let _ = (nested, callback);
            }
            "#,
            4,
        );

        assert_eq!(depth_messages(&findings).len(), 2);
        assert!(depth_messages(&findings)
            .iter()
            .all(|message| message.contains("depth 5")));
    }

    #[test]
    fn nesting_rejects_missing_empty_and_broader_function_exceptions() {
        let findings = check(
            r#"
            #[allow(clippy::excessive_nesting)]
            fn missing_reason(flag: bool) {
                if flag { loop { while flag { match flag { true => if flag {}, false => {} } } } }
            }

            #[allow(clippy::excessive_nesting, reason = "   ")]
            fn empty_reason(flag: bool) {
                if flag { loop { while flag { match flag { true => if flag {}, false => {} } } } }
            }

            #[allow(clippy::excessive_nesting, clippy::all, reason = "too broad")]
            fn broader_allow(flag: bool) {
                if flag { loop { while flag { match flag { true => if flag {}, false => {} } } } }
            }
            "#,
            4,
        );

        assert_eq!(findings.len(), 6);
        assert_eq!(
            findings
                .iter()
                .filter(|finding| finding.message == super::NESTING_EXCEPTION_ERROR)
                .count(),
            3
        );
        assert_eq!(depth_messages(&findings).len(), 3);
    }

    #[test]
    fn nesting_does_not_allow_module_level_exceptions_to_skip_functions() {
        let findings = check(
            r#"
            #[allow(clippy::excessive_nesting, reason = "module-wide suppression is too broad")]
            mod callbacks {
                fn callback(flag: bool) {
                    if flag { loop { while flag { match flag { true => if flag {}, false => {} } } } }
                }
            }
            "#,
            4,
        );

        assert_eq!(findings.len(), 2);
        assert!(findings
            .iter()
            .any(|finding| finding.message == super::NESTING_SCOPE_ERROR));
        assert_eq!(
            depth_messages(&findings),
            ["control-flow nesting depth 5 exceeds maximum 4"]
        );
    }
}
