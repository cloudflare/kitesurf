// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Parses and serializes CSS for the page's JavaScript-facing style APIs.

use cssparser::{
    AtRuleParser, CowRcStr, DeclarationParser, Parser, ParserState, QualifiedRuleParser,
    RuleBodyItemParser, RuleBodyParser, Token,
};
use servo_arc::Arc;
use style::context::QuirksMode;
use style::counter_style::{
    parse_counter_style_body, parse_counter_style_name_definition, CounterStyleRule,
    DescriptorId as CounterStyleDescriptorId,
};
use style::font_face::{parse_font_face_block, DescriptorId, Descriptors};
use style::media_queries::MediaList;
use style::parser::{Parse, ParserContext};
use style::properties::declaration_block::{
    parse_one_declaration_into, parse_style_attribute, Importance, SourcePropertyDeclarationUpdate,
};
use style::properties::{PropertyDeclarationBlock, PropertyId, SourcePropertyDeclaration};
use style::shared_lock::SharedRwLock;
use style::stylesheets::{
    AllowImportRules, CssRule, CssRuleType, Origin, PageSelectors, Stylesheet, UrlExtraData,
};
use style::typed_om::{
    numeric_declaration::NumericDeclaration, MathValue, NumericValue, PerspectiveValue, ToTyped,
    TransformComponent, TypedValue, UnparsedSegment,
};
use style_traits::{CssWriter, ParseError, ParsingMode, StyleParseErrorKind, ToCss};
use wasm_bindgen::prelude::*;

#[derive(serde::Serialize)]
struct CdpInlineProp {
    name: String,
    value: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    important: bool,
}

pub(crate) fn init_style_prefs() {
    stylo_static_prefs::set_pref!("layout.css.color-mix-multi-color.enabled", true);
    stylo_static_prefs::set_pref!("layout.container-queries.enabled", true);
    stylo_static_prefs::set_pref!("layout.variable_fonts.enabled", true);
}

#[derive(serde::Serialize)]
struct CdpParsedRule {
    selector_text: String,
    selector_specificities: Vec<u32>,
    declarations: Vec<CdpInlineProp>,
    source_line: u32,
    source_column: u32,
}

#[derive(serde::Serialize)]
struct CdpParsedSheet {
    rules: Vec<CdpParsedRule>,
}

#[derive(serde::Serialize)]
struct TypedStyleValueListDto {
    values: Vec<TypedStyleValueDto>,
}

#[derive(serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TypedStyleValueDto {
    Keyword {
        value: String,
    },
    Unit {
        value: f32,
        unit: String,
    },
    Sum {
        values: Vec<TypedStyleValueDto>,
    },
    Product {
        values: Vec<TypedStyleValueDto>,
    },
    Negate {
        value: Box<TypedStyleValueDto>,
    },
    Invert {
        value: Box<TypedStyleValueDto>,
    },
    Min {
        values: Vec<TypedStyleValueDto>,
    },
    Max {
        values: Vec<TypedStyleValueDto>,
    },
    Clamp {
        lower: Box<TypedStyleValueDto>,
        value: Box<TypedStyleValueDto>,
        upper: Box<TypedStyleValueDto>,
    },
    Unparsed {
        segments: Vec<UnparsedSegmentDto>,
    },
    Transform {
        components: Vec<TransformComponentDto>,
    },
    Generic {
        css_text: String,
    },
}

#[derive(serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum UnparsedSegmentDto {
    String {
        value: String,
    },
    Variable {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        fallback: Option<Vec<UnparsedSegmentDto>>,
    },
}

#[derive(serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TransformComponentDto {
    Translate {
        x: TypedStyleValueDto,
        y: TypedStyleValueDto,
        z: TypedStyleValueDto,
        is_2d: bool,
    },
    Rotate {
        angle: TypedStyleValueDto,
        x: TypedStyleValueDto,
        y: TypedStyleValueDto,
        z: TypedStyleValueDto,
        is_2d: bool,
    },
    Scale {
        x: TypedStyleValueDto,
        y: TypedStyleValueDto,
        z: TypedStyleValueDto,
        is_2d: bool,
    },
    Skew {
        ax: TypedStyleValueDto,
        ay: TypedStyleValueDto,
    },
    SkewX {
        angle: TypedStyleValueDto,
    },
    SkewY {
        angle: TypedStyleValueDto,
    },
    Perspective {
        length: TypedStyleValueDto,
    },
    Matrix {
        matrix: [f32; 16],
        is_2d: bool,
    },
}

fn numeric_value_to_dto(value: &NumericValue) -> TypedStyleValueDto {
    match value {
        NumericValue::Unit(value) => TypedStyleValueDto::Unit {
            value: value.value,
            unit: value.unit_str().to_string(),
        },
        NumericValue::Math(value) => match value {
            MathValue::Sum(value) => TypedStyleValueDto::Sum {
                values: value.values.iter().map(numeric_value_to_dto).collect(),
            },
            MathValue::Product(value) => TypedStyleValueDto::Product {
                values: value.values.iter().map(numeric_value_to_dto).collect(),
            },
            MathValue::Negate(value) => TypedStyleValueDto::Negate {
                value: Box::new(numeric_value_to_dto(&value.value)),
            },
            MathValue::Invert(value) => TypedStyleValueDto::Invert {
                value: Box::new(numeric_value_to_dto(&value.value)),
            },
            MathValue::Min(value) => TypedStyleValueDto::Min {
                values: value.values.iter().map(numeric_value_to_dto).collect(),
            },
            MathValue::Max(value) => TypedStyleValueDto::Max {
                values: value.values.iter().map(numeric_value_to_dto).collect(),
            },
            MathValue::Clamp(value) => TypedStyleValueDto::Clamp {
                lower: Box::new(numeric_value_to_dto(&value.values[0])),
                value: Box::new(numeric_value_to_dto(&value.values[1])),
                upper: Box::new(numeric_value_to_dto(&value.values[2])),
            },
        },
    }
}

fn unparsed_segments_to_dto(segments: &[UnparsedSegment]) -> Vec<UnparsedSegmentDto> {
    segments
        .iter()
        .map(|segment| match segment {
            UnparsedSegment::String(value) => UnparsedSegmentDto::String {
                value: value.to_string(),
            },
            UnparsedSegment::VariableReference(value) => UnparsedSegmentDto::Variable {
                name: value.variable.to_string(),
                fallback: value
                    .has_fallback
                    .then(|| unparsed_segments_to_dto(&value.fallback)),
            },
        })
        .collect()
}

fn perspective_value_to_dto(value: &PerspectiveValue) -> TypedStyleValueDto {
    match value {
        PerspectiveValue::Numeric(value) => numeric_value_to_dto(value),
        PerspectiveValue::Keyword(value) => TypedStyleValueDto::Keyword {
            value: value.0.to_string(),
        },
    }
}

fn transform_component_to_dto(value: &TransformComponent) -> TransformComponentDto {
    match value {
        TransformComponent::Translate(value) => TransformComponentDto::Translate {
            x: numeric_value_to_dto(&value.x),
            y: numeric_value_to_dto(&value.y),
            z: numeric_value_to_dto(&value.z),
            is_2d: value.is_2d,
        },
        TransformComponent::Rotate(value) => TransformComponentDto::Rotate {
            angle: numeric_value_to_dto(&value.angle),
            x: numeric_value_to_dto(&value.x),
            y: numeric_value_to_dto(&value.y),
            z: numeric_value_to_dto(&value.z),
            is_2d: value.is_2d,
        },
        TransformComponent::Scale(value) => TransformComponentDto::Scale {
            x: numeric_value_to_dto(&value.x),
            y: numeric_value_to_dto(&value.y),
            z: numeric_value_to_dto(&value.z),
            is_2d: value.is_2d,
        },
        TransformComponent::Skew(value) => TransformComponentDto::Skew {
            ax: numeric_value_to_dto(&value.ax),
            ay: numeric_value_to_dto(&value.ay),
        },
        TransformComponent::SkewX(value) => TransformComponentDto::SkewX {
            angle: numeric_value_to_dto(value),
        },
        TransformComponent::SkewY(value) => TransformComponentDto::SkewY {
            angle: numeric_value_to_dto(value),
        },
        TransformComponent::Perspective(value) => TransformComponentDto::Perspective {
            length: perspective_value_to_dto(&value.length),
        },
        TransformComponent::Matrix(value) => TransformComponentDto::Matrix {
            matrix: [
                value.matrix.m11,
                value.matrix.m12,
                value.matrix.m13,
                value.matrix.m14,
                value.matrix.m21,
                value.matrix.m22,
                value.matrix.m23,
                value.matrix.m24,
                value.matrix.m31,
                value.matrix.m32,
                value.matrix.m33,
                value.matrix.m34,
                value.matrix.m41,
                value.matrix.m42,
                value.matrix.m43,
                value.matrix.m44,
            ],
            is_2d: value.is_2d,
        },
    }
}

fn typed_value_to_dto(value: &TypedValue) -> TypedStyleValueDto {
    match value {
        TypedValue::Unparsed(value) => TypedStyleValueDto::Unparsed {
            segments: unparsed_segments_to_dto(value),
        },
        TypedValue::Keyword(value) => TypedStyleValueDto::Keyword {
            value: value.0.to_string(),
        },
        TypedValue::Numeric(value) => numeric_value_to_dto(value),
        TypedValue::Transform(value) => TypedStyleValueDto::Transform {
            components: value.iter().map(transform_component_to_dto).collect(),
        },
        TypedValue::Image(value) => TypedStyleValueDto::Generic {
            css_text: value.to_css_string(),
        },
    }
}

fn parse_typed_style_value(
    property: &str,
    css_text: &str,
) -> Result<TypedStyleValueListDto, String> {
    let property = PropertyId::parse_enabled_for_all_content(property)
        .map_err(|_| "unknown CSS property".to_string())?;
    let property_name = property.to_css_string();
    let url_data = url::Url::parse("about:kitesurf-inline-style")
        .map(UrlExtraData::from)
        .map_err(|_| "could not create CSS parser URL".to_string())?;
    let block = parse_style_attribute(
        &format!("{}: {}", property_name, css_text),
        &url_data,
        None,
        QuirksMode::NoQuirks,
        CssRuleType::Style,
    );
    if block
        .declaration_importance_iter()
        .any(|(_, importance)| importance.important())
    {
        return Err("property values cannot include !important".to_string());
    }
    let mut canonical_css = String::new();
    block
        .property_value_to_css(&property, &mut canonical_css)
        .map_err(|_| "invalid CSS property value".to_string())?;
    let values = match block
        .property_value_to_typed_value_list(&property)
        .map_err(|_| "invalid CSS property value".to_string())?
    {
        Some(values) => values.values.iter().map(typed_value_to_dto).collect(),
        None => vec![TypedStyleValueDto::Generic {
            css_text: canonical_css,
        }],
    };
    Ok(TypedStyleValueListDto { values })
}

fn parse_typed_numeric_value(css_text: &str) -> Result<TypedStyleValueDto, String> {
    let url_data = url::Url::parse("about:kitesurf-typed-numeric")
        .map(UrlExtraData::from)
        .map_err(|_| "could not create CSS parser URL".to_string())?;
    let context = ParserContext::new(
        Origin::Author,
        &url_data,
        None,
        ParsingMode::DEFAULT,
        QuirksMode::NoQuirks,
        Default::default(),
        None,
        None,
        Default::default(),
    );
    let mut input = Parser::new(css_text);
    let declaration = input
        .parse_entirely(|input| NumericDeclaration::parse(&context, input))
        .map_err(|_| "invalid CSS numeric value".to_string())?;
    match declaration.to_typed_value() {
        Some(TypedValue::Numeric(value)) => Ok(numeric_value_to_dto(&value)),
        _ => Err("CSS numeric value could not be reified".to_string()),
    }
}

#[derive(serde::Serialize)]
struct CounterStyleDescriptorDto {
    name: &'static str,
    value: String,
}

#[derive(serde::Serialize)]
struct CounterStyleRuleDto {
    name: String,
    descriptors: Vec<CounterStyleDescriptorDto>,
}

fn parse_counter_style_rule(css: &str) -> Result<CounterStyleRule, String> {
    let url_data = url::Url::parse("about:kitesurf-counter-style")
        .map(UrlExtraData::from)
        .map_err(|_| "could not create CSS parser URL".to_string())?;
    let context = ParserContext::new(
        Origin::Author,
        &url_data,
        None,
        ParsingMode::DEFAULT,
        QuirksMode::NoQuirks,
        Default::default(),
        None,
        None,
        Default::default(),
    );
    let mut input = Parser::new(css);
    input
        .parse_entirely(|input| {
            let location = input.current_source_location();
            let is_counter_style = matches!(
                input.next(),
                Ok(Token::AtKeyword(name)) if name.eq_ignore_ascii_case("counter-style")
            );
            if !is_counter_style {
                return Err(ParseError::custom(StyleParseErrorKind::UnspecifiedError));
            }
            let name = parse_counter_style_name_definition(input)?;
            input.expect_curly_bracket_block()?;
            input.parse_nested_block(|input| {
                parse_counter_style_body(name, &context, input, location)
            })
        })
        .map_err(|_| "invalid @counter-style rule".to_string())
}

fn counter_style_descriptor_id(name: &str) -> Option<CounterStyleDescriptorId> {
    match name {
        "system" => Some(CounterStyleDescriptorId::System),
        "symbols" => Some(CounterStyleDescriptorId::Symbols),
        "additive-symbols" => Some(CounterStyleDescriptorId::AdditiveSymbols),
        "negative" => Some(CounterStyleDescriptorId::Negative),
        "prefix" => Some(CounterStyleDescriptorId::Prefix),
        "suffix" => Some(CounterStyleDescriptorId::Suffix),
        "range" => Some(CounterStyleDescriptorId::Range),
        "pad" => Some(CounterStyleDescriptorId::Pad),
        "speak-as" => Some(CounterStyleDescriptorId::SpeakAs),
        "fallback" => Some(CounterStyleDescriptorId::Fallback),
        _ => None,
    }
}

fn counter_style_rule_to_dto(rule: &CounterStyleRule) -> Result<CounterStyleRuleDto, String> {
    let mut name = String::new();
    rule.name()
        .to_css(&mut CssWriter::new(&mut name))
        .map_err(|_| "could not serialize counter style name".to_string())?;
    let values = rule.descriptors();
    let mut descriptors = Vec::with_capacity(values.len());
    for index in 0..values.len() {
        let Some(id) = values.at(index) else {
            continue;
        };
        let mut value = String::new();
        values
            .get(id, &mut value)
            .map_err(|_| "could not serialize counter style descriptor".to_string())?;
        descriptors.push(CounterStyleDescriptorDto {
            name: id.name(),
            value,
        });
    }
    Ok(CounterStyleRuleDto { name, descriptors })
}

#[wasm_bindgen]
pub fn ks_counter_style_rule(css: &str, field: &str, value: &str) -> Result<JsValue, JsError> {
    let parsed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut rule = parse_counter_style_rule(css)?;
        if field.is_empty() {
            return counter_style_rule_to_dto(&rule);
        }

        let url_data = url::Url::parse("about:kitesurf-counter-style")
            .map(UrlExtraData::from)
            .map_err(|_| "could not create CSS parser URL".to_string())?;
        let context = ParserContext::new(
            Origin::Author,
            &url_data,
            None,
            ParsingMode::DEFAULT,
            QuirksMode::NoQuirks,
            Default::default(),
            None,
            None,
            Default::default(),
        );
        let mut input = Parser::new(value);
        if field == "name" {
            let name = input
                .parse_entirely(parse_counter_style_name_definition)
                .map_err(|_| "invalid counter style name".to_string())?;
            rule.set_name(name);
        } else {
            let id = counter_style_descriptor_id(field)
                .ok_or_else(|| "unknown counter style descriptor".to_string())?;
            rule.set_descriptor(id, &context, &mut input)
                .map_err(|_| "invalid counter style descriptor".to_string())?;
        }
        counter_style_rule_to_dto(&rule)
    }))
    .map_err(|_| JsError::new("counter style parsing panicked"))?
    .map_err(|error| JsError::new(&error))?;
    serde_wasm_bindgen::to_value(&parsed).map_err(|error| JsError::new(&error.to_string()))
}

#[wasm_bindgen]
pub fn ks_parse_stylesheet(css: &str) -> String {
    const MAX_STYLESHEET_SAMPLES: usize = 4;

    let _ks_span = tracing::info_span!("wasm.parse_stylesheet", css_bytes = css.len()).entered();
    let url_data = match url::Url::parse("about:kitesurf-stylesheet") {
        Ok(u) => UrlExtraData::from(u),
        Err(e) => {
            return format!(
                "{{\"ok\":false,\"error\":\"url parse: {}\"}}",
                e.to_string().replace('"', "'")
            );
        }
    };

    let lock = SharedRwLock::new();
    let media = Arc::new(lock.wrap(MediaList::empty()));

    let stylesheet = Stylesheet::from_str(
        css,
        url_data,
        Origin::Author,
        media,
        lock.clone(),
        None,
        None,
        style::context::QuirksMode::NoQuirks,
        AllowImportRules::Yes,
    );

    let guard = lock.read();
    let contents = stylesheet.contents.read_with(&guard);

    let mut rule_count = 0usize;
    let mut style_rule_count = 0usize;
    let mut page_rule_count = 0usize;
    let mut declaration_count = 0usize;
    let mut samples: Vec<String> = Vec::new();
    let mut page_samples: Vec<String> = Vec::new();

    for rule in contents.rules.read_with(&guard).0.iter() {
        rule_count += 1;
        match rule {
            CssRule::Style(style_rule) => {
                style_rule_count += 1;
                let style_rule = style_rule.read_with(&guard);
                let block = style_rule.block.read_with(&guard);
                declaration_count += block.declarations().len();
                for decl in block.declarations().iter() {
                    if samples.len() >= MAX_STYLESHEET_SAMPLES {
                        break;
                    }
                    let mut value = String::new();
                    let _ = decl.to_css(&mut value);
                    samples.push(format!("{}:{}", decl.id().name(), value));
                }
            }
            // Report parsed `@page` declarations to verify the Stylo 0.22 parser patch.
            CssRule::Page(page_rule) => {
                page_rule_count += 1;
                let page_rule = page_rule.read_with(&guard);
                let block = page_rule.block.read_with(&guard);
                for decl in block.declarations().iter() {
                    if page_samples.len() >= MAX_STYLESHEET_SAMPLES {
                        break;
                    }
                    let mut value = String::new();
                    let _ = decl.to_css(&mut value);
                    page_samples.push(format!("{}:{}", decl.id().name(), value));
                }
            }
            _ => {}
        }
    }

    let samples_json = samples
        .iter()
        .map(|s| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(",");
    let page_samples_json = page_samples
        .iter()
        .map(|s| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(",");

    format!(
        "{{\"ok\":true,\"rules\":{},\"style_rules\":{},\"page_rules\":{},\"declarations\":{},\"samples\":[{}],\"page_samples\":[{}]}}",
        rule_count, style_rule_count, page_rule_count, declaration_count, samples_json, page_samples_json
    )
}

#[wasm_bindgen]
pub fn ks_stylo_smoke() -> String {
    let _ = stylo_atoms::Atom::from("color");
    String::from("ok")
}

#[wasm_bindgen]
pub fn ks_ua_stylesheet() -> String {
    crate::BLITZ_DEFAULT_CSS.to_string()
}

#[wasm_bindgen]
pub fn ks_validate_selector(selector: &str) -> String {
    let url_data = match url::Url::parse("about:kitesurf-selector") {
        Ok(u) => UrlExtraData::from(u),
        Err(e) => {
            return format!(
                "{{\"ok\":false,\"error\":\"url parse: {}\"}}",
                e.to_string().replace('"', "'")
            );
        }
    };

    match style::selector_parser::SelectorParser::parse_author_origin_no_namespace(
        selector, &url_data,
    ) {
        Ok(list) => {
            let count = list.slice().len();
            let first_specificity = list.slice().first().map(|s| s.specificity()).unwrap_or(0);
            format!(
                "{{\"ok\":true,\"selectors\":{},\"first_specificity\":{}}}",
                count, first_specificity
            )
        }
        Err(e) => {
            let msg = format!("{:?}", e).replace('\\', "\\\\").replace('"', "'");
            format!("{{\"ok\":false,\"error\":\"{}\"}}", msg)
        }
    }
}

#[wasm_bindgen]
pub fn ks_canonicalize_page_selectors(prelude: &str) -> Option<String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let url_data = UrlExtraData::from(url::Url::parse("about:kitesurf-selector").ok()?);
        let context = parser_context(&url_data, CssRuleType::Page);
        let mut parser = Parser::new(prelude);
        parser.skip_whitespace();
        if parser.is_exhausted() {
            return Some(String::new());
        }
        let selectors = parser
            .parse_entirely(|input| PageSelectors::parse(&context, input))
            .ok()?;
        if selectors
            .as_slice()
            .iter()
            .any(|s| s.name.starts_with("--"))
        {
            return None;
        }
        Some(selectors.to_css_string())
    }))
    .ok()
    .flatten()
}

#[wasm_bindgen]
pub fn ks_parse_inline_style(css: &str) -> Result<JsValue, JsError> {
    let url_data = match url::Url::parse("about:kitesurf-inline-style") {
        Ok(u) => UrlExtraData::from(u),
        Err(_) => {
            return serde_wasm_bindgen::to_value(&Vec::<CdpInlineProp>::new())
                .map_err(|e| JsError::new(&e.to_string()));
        }
    };

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let block = parse_style_attribute(
            css,
            &url_data,
            None,
            QuirksMode::NoQuirks,
            CssRuleType::Style,
        );
        let mut out: Vec<CdpInlineProp> = Vec::with_capacity(block.declarations().len());
        for (decl, importance) in block.declaration_importance_iter() {
            let name = decl.id().name().into_owned();
            let mut value = String::new();
            if decl.to_css(&mut value).is_err() {
                continue;
            }
            out.push(CdpInlineProp {
                name,
                value,
                important: importance.important(),
            });
        }
        out
    }));
    let props = result.unwrap_or_default();
    serde_wasm_bindgen::to_value(&props).map_err(|e| JsError::new(&e.to_string()))
}

#[derive(Clone)]
enum RuleStyleBacking {
    Properties {
        block: PropertyDeclarationBlock,
        rule_type: CssRuleType,
    },
    FontFace(Descriptors),
}

#[wasm_bindgen]
#[derive(Clone)]
pub struct RuleStyleDeclarationStore {
    backing: RuleStyleBacking,
    url_data: UrlExtraData,
    cascade_text: String,
    names: Vec<String>,
}

struct DeclarationNameCollector {
    names: Vec<String>,
}

struct FontFaceNameCollector<'a> {
    url_data: &'a UrlExtraData,
    names: Vec<String>,
}

impl<'a, 'i> AtRuleParser<'i> for FontFaceNameCollector<'a> {
    type Prelude = ();
    type AtRule = ();
    type Error = StyleParseErrorKind;
}

impl<'a, 'i> QualifiedRuleParser<'i> for FontFaceNameCollector<'a> {
    type Prelude = ();
    type QualifiedRule = ();
    type Error = StyleParseErrorKind;
}

impl<'a, 'i> RuleBodyItemParser<'i, (), StyleParseErrorKind> for FontFaceNameCollector<'a> {
    fn parse_qualified(&self) -> bool {
        false
    }

    fn parse_declarations(&self) -> bool {
        true
    }
}

impl<'a, 'i> DeclarationParser<'i> for FontFaceNameCollector<'a> {
    type Declaration = ();
    type Error = StyleParseErrorKind;

    fn parse_value(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i>,
        _declaration_start: &ParserState,
    ) -> Result<(), ParseError> {
        let id = DescriptorId::from_ident(&name)
            .map_err(|_| ParseError::custom(StyleParseErrorKind::UnspecifiedError))?;
        let context = parser_context(self.url_data, CssRuleType::FontFace);
        let mut descriptor = Descriptors::default();
        if !descriptor.set(id, &context, input).unwrap_or(false) {
            return Err(ParseError::custom(StyleParseErrorKind::UnspecifiedError));
        }
        let name = id.name().to_string();
        self.names
            .retain(|candidate| !candidate.eq_ignore_ascii_case(&name));
        self.names.push(name);
        Ok(())
    }
}

impl<'i> AtRuleParser<'i> for DeclarationNameCollector {
    type Prelude = ();
    type AtRule = ();
    type Error = StyleParseErrorKind;
}

impl<'i> QualifiedRuleParser<'i> for DeclarationNameCollector {
    type Prelude = ();
    type QualifiedRule = ();
    type Error = StyleParseErrorKind;
}

impl<'i> RuleBodyItemParser<'i, (), StyleParseErrorKind> for DeclarationNameCollector {
    fn parse_qualified(&self) -> bool {
        false
    }

    fn parse_declarations(&self) -> bool {
        true
    }
}

impl<'i> DeclarationParser<'i> for DeclarationNameCollector {
    type Declaration = ();
    type Error = StyleParseErrorKind;

    fn parse_value(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i>,
        _declaration_start: &ParserState,
    ) -> Result<(), ParseError> {
        while input.next_including_whitespace_and_comments().is_ok() {}
        self.names.push(if name.starts_with("--") {
            name.to_string()
        } else {
            name.to_ascii_lowercase()
        });
        Ok(())
    }
}

fn declaration_names(css: &str) -> Vec<String> {
    let mut parser = Parser::new(css);
    let mut collector = DeclarationNameCollector { names: Vec::new() };
    for _ in RuleBodyParser::new(&mut parser, &mut collector) {}
    collector.names
}

fn font_face_descriptor_names(css: &str, url_data: &UrlExtraData) -> Vec<String> {
    let mut parser = Parser::new(css);
    let mut collector = FontFaceNameCollector {
        url_data,
        names: Vec::new(),
    };
    for _ in RuleBodyParser::new(&mut parser, &mut collector) {}
    collector.names
}

fn rule_style_url_data(base_url: &str) -> Result<UrlExtraData, JsError> {
    url::Url::parse(base_url)
        .map(UrlExtraData::from)
        .map_err(|error| JsError::new(&error.to_string()))
}

fn parser_context(url_data: &UrlExtraData, rule_type: CssRuleType) -> ParserContext<'_> {
    ParserContext::new(
        Origin::Author,
        url_data,
        Some(rule_type),
        ParsingMode::DEFAULT,
        QuirksMode::NoQuirks,
        Default::default(),
        None,
        None,
        Default::default(),
    )
}

fn parse_font_face_descriptors(css: &str, url_data: &UrlExtraData) -> Descriptors {
    let context = parser_context(url_data, CssRuleType::FontFace);
    let mut parser = Parser::new(css);
    let location = parser.current_source_location();
    parse_font_face_block(&context, &mut parser, location).descriptors
}

impl RuleStyleDeclarationStore {
    fn panic_error() -> JsError {
        JsError::new("rule style declaration operation panicked")
    }

    fn canonical_text(&self) -> String {
        let mut output = String::new();
        match &self.backing {
            RuleStyleBacking::Properties { block, .. } => {
                let _ = block.to_css(&mut output);
            }
            RuleStyleBacking::FontFace(descriptors) => {
                for name in &self.names {
                    let Ok(id) = DescriptorId::from_ident(name) else {
                        continue;
                    };
                    let mut value = String::new();
                    if descriptors.get(id, &mut value).is_ok() && !value.is_empty() {
                        if !output.is_empty() {
                            output.push(' ');
                        }
                        output.push_str(id.name());
                        output.push_str(": ");
                        output.push_str(&value);
                        output.push(';');
                    }
                }
            }
        }
        output
    }

    fn property_id(
        url_data: &UrlExtraData,
        rule_type: CssRuleType,
        name: &str,
    ) -> Option<PropertyId> {
        PropertyId::parse(name, &parser_context(url_data, rule_type)).ok()
    }

    fn has_descriptor(descriptors: &Descriptors, id: DescriptorId) -> bool {
        (0..descriptors.len()).any(|index| descriptors.at(index) == Some(id))
    }

    fn refresh_names(&mut self, source_text: &str) {
        self.names = match &self.backing {
            RuleStyleBacking::Properties { .. } => declaration_names(&self.canonical_text()),
            RuleStyleBacking::FontFace(_) => {
                font_face_descriptor_names(source_text, &self.url_data)
            }
        };
    }

    fn commit_mutation(&mut self) {
        // Property-level mutations canonicalize cascade text; cssText preserves supplied text.
        let canonical = self.canonical_text();
        if matches!(self.backing, RuleStyleBacking::Properties { .. }) {
            self.names = declaration_names(&canonical);
        }
        self.cascade_text = canonical;
    }
}

#[wasm_bindgen]
impl RuleStyleDeclarationStore {
    #[wasm_bindgen(constructor)]
    pub fn new(
        context: &str,
        css_text: &str,
        base_url: &str,
    ) -> Result<RuleStyleDeclarationStore, JsError> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Self::new_inner(context, css_text, base_url)
        }))
        .map_err(|_| Self::panic_error())?
    }

    fn new_inner(
        context: &str,
        css_text: &str,
        base_url: &str,
    ) -> Result<RuleStyleDeclarationStore, JsError> {
        let url_data = rule_style_url_data(base_url)?;
        let backing = match context {
            "style" | "keyframe" | "page" => {
                let rule_type = match context {
                    "style" => CssRuleType::Style,
                    "keyframe" => CssRuleType::Keyframe,
                    _ => CssRuleType::Page,
                };
                RuleStyleBacking::Properties {
                    block: parse_style_attribute(
                        css_text,
                        &url_data,
                        None,
                        QuirksMode::NoQuirks,
                        rule_type,
                    ),
                    rule_type,
                }
            }
            "font-face" => {
                RuleStyleBacking::FontFace(parse_font_face_descriptors(css_text, &url_data))
            }
            _ => return Err(JsError::new("unknown rule declaration context")),
        };
        let mut store = Self {
            backing,
            url_data,
            cascade_text: css_text.to_string(),
            names: Vec::new(),
        };
        store.refresh_names(css_text);
        Ok(store)
    }

    #[wasm_bindgen(js_name = cssText)]
    pub fn css_text(&self) -> String {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.canonical_text()))
            .unwrap_or_default()
    }

    #[wasm_bindgen(js_name = cascadeText)]
    pub fn cascade_text(&self) -> String {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.cascade_text.clone()))
            .unwrap_or_default()
    }

    #[wasm_bindgen(js_name = getPropertyValue)]
    pub fn get_property_value(&self, name: &str) -> String {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.get_property_value_inner(name)
        }))
        .unwrap_or_default()
    }

    fn get_property_value_inner(&self, name: &str) -> String {
        let mut output = String::new();
        match &self.backing {
            RuleStyleBacking::Properties { block, rule_type } => {
                let Some(id) = Self::property_id(&self.url_data, *rule_type, name) else {
                    return output;
                };
                let _ = block.property_value_to_css(&id, &mut output);
            }
            RuleStyleBacking::FontFace(descriptors) => {
                let Ok(id) = DescriptorId::from_ident(name) else {
                    return output;
                };
                let _ = descriptors.get(id, &mut output);
            }
        }
        output
    }

    #[wasm_bindgen(js_name = getPropertyPriority)]
    pub fn get_property_priority(&self, name: &str) -> String {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.get_property_priority_inner(name)
        }))
        .unwrap_or_default()
    }

    fn get_property_priority_inner(&self, name: &str) -> String {
        let RuleStyleBacking::Properties { block, rule_type } = &self.backing else {
            return String::new();
        };
        let Some(id) = Self::property_id(&self.url_data, *rule_type, name) else {
            return String::new();
        };
        if block.property_priority(&id).important() {
            "important".to_string()
        } else {
            String::new()
        }
    }

    #[wasm_bindgen(js_name = setProperty)]
    pub fn set_property(&mut self, name: &str, value: &str, priority: &str) -> bool {
        let snapshot = self.clone();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.set_property_inner(name, value, priority)
        })) {
            Ok(changed) => changed,
            Err(_) => {
                *self = snapshot;
                false
            }
        }
    }

    fn set_property_inner(&mut self, name: &str, value: &str, priority: &str) -> bool {
        if value.is_empty() {
            let had = self.has_property_inner(name);
            self.remove_property_inner(name);
            return had;
        }
        let importance = if priority.is_empty() {
            Importance::Normal
        } else if priority.eq_ignore_ascii_case("important") {
            Importance::Important
        } else {
            return false;
        };

        let changed = match &mut self.backing {
            RuleStyleBacking::Properties { block, rule_type } => {
                if *rule_type == CssRuleType::Keyframe && importance.important() {
                    return false;
                }
                let Some(id) = Self::property_id(&self.url_data, *rule_type, name) else {
                    return false;
                };
                let mut declarations = SourcePropertyDeclaration::default();
                if parse_one_declaration_into(
                    &mut declarations,
                    id,
                    value,
                    Origin::Author,
                    &self.url_data,
                    None,
                    ParsingMode::DEFAULT,
                    QuirksMode::NoQuirks,
                    *rule_type,
                )
                .is_err()
                {
                    return false;
                }
                let mut updates = SourcePropertyDeclarationUpdate::default();
                if !block.prepare_for_update(&declarations, importance, &mut updates) {
                    return false;
                }
                block.update(declarations.drain(), importance, &mut updates);
                true
            }
            RuleStyleBacking::FontFace(descriptors) => {
                if !priority.is_empty() {
                    return false;
                }
                let Ok(id) = DescriptorId::from_ident(name) else {
                    return false;
                };
                let context = parser_context(&self.url_data, CssRuleType::FontFace);
                let mut parser = Parser::new(value);
                descriptors.set(id, &context, &mut parser).unwrap_or(false)
            }
        };

        if changed {
            if matches!(self.backing, RuleStyleBacking::FontFace(_)) {
                if let Ok(id) = DescriptorId::from_ident(name) {
                    let name = id.name().to_string();
                    if !self.names.contains(&name) {
                        self.names.push(name);
                    }
                }
            }
            self.commit_mutation();
        }
        changed
    }

    #[wasm_bindgen(js_name = hasProperty)]
    pub fn has_property(&self, name: &str) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.has_property_inner(name)
        }))
        .unwrap_or(false)
    }

    fn has_property_inner(&self, name: &str) -> bool {
        match &self.backing {
            RuleStyleBacking::Properties { block, rule_type } => {
                let Some(id) = Self::property_id(&self.url_data, *rule_type, name) else {
                    return false;
                };
                block.first_declaration_to_remove(&id).is_some()
            }
            RuleStyleBacking::FontFace(descriptors) => DescriptorId::from_ident(name)
                .map(|id| Self::has_descriptor(descriptors, id))
                .unwrap_or(false),
        }
    }

    #[wasm_bindgen(js_name = removeProperty)]
    pub fn remove_property(&mut self, name: &str) -> String {
        let snapshot = self.clone();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.remove_property_inner(name)
        })) {
            Ok(value) => value,
            Err(_) => {
                *self = snapshot;
                String::new()
            }
        }
    }

    fn remove_property_inner(&mut self, name: &str) -> String {
        let old_value = self.get_property_value_inner(name);
        let mut removed = false;
        match &mut self.backing {
            RuleStyleBacking::Properties { block, rule_type } => {
                let Some(id) = Self::property_id(&self.url_data, *rule_type, name) else {
                    return String::new();
                };
                if let Some(first) = block.first_declaration_to_remove(&id) {
                    block.remove_property(&id, first);
                    removed = true;
                }
            }
            RuleStyleBacking::FontFace(descriptors) => {
                if let Ok(id) = DescriptorId::from_ident(name) {
                    removed = descriptors.remove(id);
                }
            }
        }
        if removed {
            if matches!(self.backing, RuleStyleBacking::FontFace(_)) {
                self.names
                    .retain(|candidate| !candidate.eq_ignore_ascii_case(name));
            }
            self.commit_mutation();
        }
        old_value
    }

    pub fn length(&self) -> u32 {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.names.len() as u32))
            .unwrap_or(0)
    }

    pub fn item(&self, index: u32) -> String {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.names.get(index as usize).cloned().unwrap_or_default()
        }))
        .unwrap_or_default()
    }

    #[wasm_bindgen(js_name = setCssText)]
    pub fn set_css_text(&mut self, css_text: &str) {
        let snapshot = self.clone();
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.set_css_text_inner(css_text)
        }))
        .is_err()
        {
            *self = snapshot;
        }
    }

    fn set_css_text_inner(&mut self, css_text: &str) {
        match &mut self.backing {
            RuleStyleBacking::Properties { block, rule_type } => {
                *block = parse_style_attribute(
                    css_text,
                    &self.url_data,
                    None,
                    QuirksMode::NoQuirks,
                    *rule_type,
                );
            }
            RuleStyleBacking::FontFace(descriptors) => {
                *descriptors = parse_font_face_descriptors(css_text, &self.url_data);
            }
        }
        self.cascade_text = css_text.to_string();
        self.refresh_names(css_text);
    }
}

#[wasm_bindgen]
pub fn ks_parse_typed_style_value(property: &str, css_text: &str) -> Result<JsValue, JsError> {
    let parsed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        parse_typed_style_value(property, css_text)
    }))
    .map_err(|_| JsError::new("typed style value parsing panicked"))?
    .map_err(|error| JsError::new(&error))?;
    serde_wasm_bindgen::to_value(&parsed).map_err(|error| JsError::new(&error.to_string()))
}

#[wasm_bindgen]
pub fn ks_parse_typed_numeric_value(css_text: &str) -> Result<JsValue, JsError> {
    let parsed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        parse_typed_numeric_value(css_text)
    }))
    .map_err(|_| JsError::new("typed numeric value parsing panicked"))?
    .map_err(|error| JsError::new(&error))?;
    serde_wasm_bindgen::to_value(&parsed).map_err(|error| JsError::new(&error.to_string()))
}

#[wasm_bindgen]
pub fn ks_serialize_inline_style(css: &str) -> String {
    let url_data = match url::Url::parse("about:kitesurf-inline-style") {
        Ok(u) => UrlExtraData::from(u),
        Err(_) => return String::new(),
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let block = parse_style_attribute(
            css,
            &url_data,
            None,
            QuirksMode::NoQuirks,
            CssRuleType::Style,
        );
        let mut out = String::new();
        if block.to_css(&mut out).is_err() {
            return String::new();
        }
        out
    }));
    result.unwrap_or_default()
}

#[wasm_bindgen]
pub fn ks_get_property_value(css: &str, property: &str) -> String {
    let url_data = match url::Url::parse("about:kitesurf-inline-style") {
        Ok(u) => UrlExtraData::from(u),
        Err(_) => return String::new(),
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let prop_id = match PropertyId::parse_enabled_for_all_content(property) {
            Ok(id) => id,
            Err(_) => return String::new(),
        };
        let block = parse_style_attribute(
            css,
            &url_data,
            None,
            QuirksMode::NoQuirks,
            CssRuleType::Style,
        );
        let mut out = String::new();
        if block.property_value_to_css(&prop_id, &mut out).is_err() {
            return String::new();
        }
        out
    }));
    result.unwrap_or_default()
}

#[wasm_bindgen]
pub fn ks_parse_stylesheet_structured(css: &str) -> Result<JsValue, JsError> {
    use cssparser::ToCss;
    use style::stylesheets::CssRule;

    let url_data = match url::Url::parse("about:kitesurf-stylesheet") {
        Ok(u) => UrlExtraData::from(u),
        Err(_) => {
            return serde_wasm_bindgen::to_value(&CdpParsedSheet { rules: Vec::new() })
                .map_err(|e| JsError::new(&e.to_string()));
        }
    };

    let lock = SharedRwLock::new();
    let media = Arc::new(lock.wrap(MediaList::empty()));

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let stylesheet = Stylesheet::from_str(
            css,
            url_data,
            Origin::Author,
            media,
            lock.clone(),
            None,
            None,
            QuirksMode::NoQuirks,
            AllowImportRules::Yes,
        );
        let guard = lock.read();
        let contents = stylesheet.contents.read_with(&guard);
        let mut rules: Vec<CdpParsedRule> = Vec::new();
        for rule in contents.rules.read_with(&guard).0.iter() {
            let CssRule::Style(style_rule) = rule else {
                continue;
            };
            let style_rule = style_rule.read_with(&guard);

            let mut selector_text = String::new();
            if style_rule.selectors.to_css(&mut selector_text).is_err() {
                continue;
            }

            let selector_specificities: Vec<u32> = style_rule
                .selectors
                .slice()
                .iter()
                .map(|s| s.specificity())
                .collect();

            let block = style_rule.block.read_with(&guard);
            let mut declarations: Vec<CdpInlineProp> =
                Vec::with_capacity(block.declarations().len());
            for (decl, importance) in block.declaration_importance_iter() {
                let name = decl.id().name().into_owned();
                let mut value = String::new();
                if decl.to_css(&mut value).is_err() {
                    continue;
                }
                declarations.push(CdpInlineProp {
                    name,
                    value,
                    important: importance.important(),
                });
            }

            rules.push(CdpParsedRule {
                selector_text,
                selector_specificities,
                declarations,
                source_line: style_rule.source_location.line,
                source_column: style_rule.source_location.column,
            });
        }
        CdpParsedSheet { rules }
    }));
    let sheet = result.unwrap_or(CdpParsedSheet { rules: Vec::new() });
    serde_wasm_bindgen::to_value(&sheet).map_err(|e| JsError::new(&e.to_string()))
}

#[cfg(test)]
mod typed_style_value_tests {
    use super::*;

    fn parse_json(property: &str, css_text: &str) -> serde_json::Value {
        serde_json::to_value(parse_typed_style_value(property, css_text).unwrap()).unwrap()
    }

    fn parse_numeric_json(css_text: &str) -> serde_json::Value {
        serde_json::to_value(parse_typed_numeric_value(css_text).unwrap()).unwrap()
    }

    #[test]
    fn reifies_keyword_unit_and_math_values() {
        assert_eq!(
            parse_json("display", "block"),
            serde_json::json!({"values": [{"type": "keyword", "value": "block"}]})
        );
        assert_eq!(
            parse_json("margin-left", "12px"),
            serde_json::json!({"values": [{"type": "unit", "value": 12.0, "unit": "px"}]})
        );

        let sum = parse_json("width", "calc(10px + 2em)");
        assert_eq!(sum["values"][0]["type"], "sum");
        let units: Vec<_> = sum["values"][0]["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value["unit"].as_str().unwrap())
            .collect();
        assert!(units.contains(&"px"));
        assert!(units.contains(&"em"));

        assert_eq!(
            parse_json("width", "min(10px, 20%)")["values"][0]["type"],
            "min"
        );
        assert_eq!(
            parse_json("width", "max(10px, 20%)")["values"][0]["type"],
            "max"
        );
        assert_eq!(
            parse_json("width", "clamp(10px, 20%, 30px)")["values"][0]["type"],
            "clamp"
        );
    }

    #[test]
    fn reifies_unparsed_and_transform_values() {
        let unparsed = parse_json("width", "var(--base, 10px)");
        assert_eq!(unparsed["values"][0]["type"], "unparsed");
        assert_eq!(unparsed["values"][0]["segments"][0]["type"], "variable");
        assert_eq!(unparsed["values"][0]["segments"][0]["name"], "--base");

        let transform = parse_json("transform", "translate(10px, 20%) rotate(30deg)");
        assert_eq!(transform["values"][0]["type"], "transform");
        assert_eq!(transform["values"][0]["components"][0]["type"], "translate");
        assert_eq!(transform["values"][0]["components"][1]["type"], "rotate");
    }

    #[test]
    fn uses_generic_fallback_and_rejects_invalid_input() {
        assert_eq!(
            parse_json("color", "rgb(1 2 3)"),
            serde_json::json!({
                "values": [{"type": "generic", "css_text": "rgb(1, 2, 3)"}]
            })
        );
        assert!(parse_typed_style_value("not-a-property", "1px").is_err());
        assert!(parse_typed_style_value("width", "not-a-width").is_err());
        assert!(parse_typed_style_value("width", "1px !important").is_err());
    }

    #[test]
    fn parses_standalone_typed_numeric_values() {
        assert_eq!(
            parse_numeric_json("12px"),
            serde_json::json!({"type": "unit", "value": 12.0, "unit": "px"})
        );
        assert_eq!(parse_numeric_json("calc(10px + 2em)")["type"], "sum");
        let product = parse_numeric_json("calc(10px * 2)");
        assert_eq!(product["type"], "sum");
        assert_eq!(product["values"][0]["value"], 20.0);
        assert_eq!(product["values"][0]["unit"], "px");
        assert_eq!(parse_numeric_json("min(10px, 20%)")["type"], "min");
        assert_eq!(parse_numeric_json("max(10px, 20%)")["type"], "max");
        assert_eq!(
            parse_numeric_json("clamp(10px, 20%, 30px)")["type"],
            "clamp"
        );
        assert!(parse_typed_numeric_value("red").is_err());
        assert!(parse_typed_numeric_value("12px trailing").is_err());
    }
}
