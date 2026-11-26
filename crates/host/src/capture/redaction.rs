//! Shared rule evaluation for capture redaction. Each input is one UTF-8 line.
use regex::{Regex, RegexBuilder};
use serial_workbench_core::{
    CaptureRedactionPreviewParams, CaptureRedactionPreviewResult, CaptureRedactionRule, HostError,
    HostResult,
};

mod recording;
pub(super) use recording::RecordingRedactor;

const MAX_RULES: usize = 16;
const REGEX_BUDGET: usize = 256 * 1024;
const MAX_PATTERN_BYTES: usize = 256;
const MAX_REPLACEMENT_BYTES: usize = 128;
const MAX_SAMPLE_BYTES: usize = 8 * 1024;
const MAX_SAMPLE_LINES: usize = 64;
const MAX_OUTPUT_BYTES: usize = 32 * 1024;
const MAX_LINE_REPLACEMENTS: u64 = 1024;

struct Rule {
    pattern: Regex,
    replacement: String,
}
struct CompiledRules(Vec<Rule>);

impl CompiledRules {
    fn new(input: Vec<CaptureRedactionRule>) -> HostResult<Self> {
        if !(1..=MAX_RULES).contains(&input.len()) {
            return Err(invalid("Use between 1 and 16 redaction rules"));
        }
        let mut rules = Vec::with_capacity(input.len());
        for (position, rule) in input.into_iter().enumerate() {
            let index = position + 1;
            if rule.pattern.is_empty()
                || rule.pattern.len() > MAX_PATTERN_BYTES
                || rule.replacement.len() > MAX_REPLACEMENT_BYTES
                || !is_text_line(&rule.replacement)
            {
                return Err(invalid_rule(
                    index,
                    "Redaction rule is outside the allowed text limits",
                ));
            }
            let pattern = RegexBuilder::new(&rule.pattern)
                .size_limit(REGEX_BUDGET)
                .dfa_size_limit(REGEX_BUDGET)
                .build()
                .map_err(|_| invalid_rule(index, "Invalid or unsupported redaction expression"))?;
            if pattern.is_match("") {
                return Err(invalid_rule(
                    index,
                    "Redaction expressions must consume text",
                ));
            }
            rules.push(Rule {
                pattern,
                replacement: rule.replacement,
            });
        }
        Ok(Self(rules))
    }

    fn apply_line(&self, input: &str) -> HostResult<(String, u64)> {
        if input.len() > MAX_SAMPLE_BYTES || !is_text_line(input) {
            return Err(invalid("Redaction requires a bounded text line"));
        }
        let mut text = input.to_owned();
        let mut replacements = 0;
        for (position, rule) in self.0.iter().enumerate() {
            let mut previous = 0;
            let mut output = String::new();
            for hit in rule.pattern.find_iter(&text) {
                if hit.is_empty() {
                    return Err(invalid_rule(
                        position + 1,
                        "Redaction expressions must consume text",
                    ));
                }
                replacements += 1;
                if replacements > MAX_LINE_REPLACEMENTS {
                    return Err(limit());
                }
                append(&mut output, &text[previous..hit.start()])?;
                append(&mut output, &rule.replacement)?;
                previous = hit.end();
            }
            if previous > 0 {
                append(&mut output, &text[previous..])?;
                text = output;
            }
        }
        Ok((text, replacements))
    }
}

pub(crate) fn preview(
    params: CaptureRedactionPreviewParams,
) -> HostResult<CaptureRedactionPreviewResult> {
    if params.sample.is_empty() || params.sample.len() > MAX_SAMPLE_BYTES {
        return Err(invalid("Provide a redaction sample of up to 8192 bytes"));
    }
    let rules = CompiledRules::new(params.rules)?;
    let mut text = String::new();
    let mut replacements = 0;
    for (position, fragment) in params.sample.split_inclusive('\n').enumerate() {
        if position >= MAX_SAMPLE_LINES {
            return Err(limit());
        }
        let (line, ending) = fragment
            .strip_suffix("\r\n")
            .map(|line| (line, "\r\n"))
            .or_else(|| fragment.strip_suffix('\n').map(|line| (line, "\n")))
            .unwrap_or((fragment, ""));
        let (processed, applied) = rules.apply_line(line)?;
        append(&mut text, &processed)?;
        append(&mut text, ending)?;
        replacements += applied;
    }
    Ok(CaptureRedactionPreviewResult {
        text,
        replacements: replacements.into(),
    })
}

pub(super) fn recording_reservation(sources: usize, rules: usize) -> HostResult<usize> {
    if !(1..=MAX_RULES).contains(&rules) {
        return Err(invalid("Use between 1 and 16 redaction rules"));
    }
    Ok((REGEX_BUDGET * 2) * rules + (MAX_SAMPLE_BYTES + 2) * sources * 4 + 6 * MAX_OUTPUT_BYTES)
}

pub(super) fn valid_output(text: &str, count: serial_workbench_core::U64) -> bool {
    text.len() <= MAX_OUTPUT_BYTES && is_text_line(text) && count.get() <= MAX_LINE_REPLACEMENTS
}

fn is_text_line(text: &str) -> bool {
    text.chars().all(|ch| !ch.is_control() || ch == '\t')
}

fn append(output: &mut String, part: &str) -> HostResult<()> {
    if output.len().saturating_add(part.len()) > MAX_OUTPUT_BYTES {
        return Err(limit());
    }
    output.push_str(part);
    Ok(())
}

fn invalid(message: &'static str) -> HostError {
    HostError::new("INVALID_ARGUMENT", message)
}

fn invalid_rule(index: usize, message: &'static str) -> HostError {
    let mut error = invalid(message);
    error.details = Some(Box::new(
        serde_json::from_value(serde_json::json!({"ruleIndex": index}))
            .expect("bounded rule index"),
    ));
    error
}

fn limit() -> HostError {
    HostError::new("LIMIT_EXCEEDED", "Capture redaction budget exhausted")
}
