//! Host typed 目录到 MCP 工具的机械映射。
use rmcp::model::{Tool, ToolAnnotations};
use serde_json::{Value, json};
use serial_workbench_core::*;
use std::{fmt::Write, sync::Arc};

pub(crate) fn tool_name(action: &str) -> HostResult<String> {
    let mut name = String::from("swb_");
    for byte in action.bytes() {
        if byte.is_ascii_alphanumeric() {
            name.push(char::from(byte));
        } else {
            write!(name, "_x{byte:02X}_").expect("string writer");
        }
    }
    if name.len() > 128 {
        return Err(HostError::new(
            "LIMIT_EXCEEDED",
            "Encoded MCP tool name exceeds 128 bytes",
        ));
    }
    Ok(name)
}

pub(crate) fn resolve(name: &str) -> Option<BuiltinAction> {
    BuiltinAction::ALL
        .into_iter()
        .find(|action| tool_name(action.action_id()).is_ok_and(|encoded| encoded == name))
}

pub(crate) fn tool(spec: &ActionSpec) -> HostResult<Tool> {
    // 只改变 schema 方言；Rust 参数/结果映射仍由 Core 唯一定义持有。
    let typed =
        BuiltinAction::find(spec.action_id.as_str())?.spec_with_dialect(SchemaDialect::Draft202012);
    let action = spec.kind == ActionKind::Action;
    let mut wire = if action {
        schema_for::<Call>(SchemaDialect::Draft202012)
    } else {
        schema_for::<Query>(SchemaDialect::Draft202012)
    };
    let mut params = serde_json::to_value(typed.input_schema).map_err(|_| invalid_schema())?;
    scope_refs(&mut wire, "Wire");
    scope_refs(&mut params, "Params");
    let mut input = json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "type":"object", "additionalProperties":false,
        "required":["target","params"],
        "properties":{
            "target":{"$ref":"#/$defs/Wire/properties/target"},
            "requestId":{"$ref":"#/$defs/Wire/properties/requestId"},
            "params":{"$ref":"#/$defs/Params"}
        },
        "$defs":{"Wire":wire,"Params":params}
    });
    if action {
        let properties = input["properties"]
            .as_object_mut()
            .expect("schema properties");
        for field in ["expectedRevision", "leaseId", "executionMode"] {
            properties.insert(
                field.into(),
                json!({"$ref":format!("#/$defs/Wire/properties/{field}")}),
            );
        }
    }
    let output = if action {
        schema_for::<Operation>(SchemaDialect::Draft202012)
    } else {
        serde_json::to_value(typed.output_schema).map_err(|_| invalid_schema())?
    };
    Ok(Tool::new(
        tool_name(spec.action_id.as_str())?,
        if action {
            format!(
                "{}. Returns the accepted operation; query operation.get for its result.",
                spec.action_id
            )
        } else {
            format!("{}. Returns its bounded query result.", spec.action_id)
        },
        input.as_object().ok_or_else(invalid_schema)?.clone(),
    )
    .with_raw_output_schema(Arc::new(
        output.as_object().ok_or_else(invalid_schema)?.clone(),
    ))
    .with_annotations(ToolAnnotations::new().read_only(!action)))
}

/// 嵌入独立 schema 时重定位根引用，不复制或改写领域约束。
fn scope_refs(schema: &mut Value, component: &str) {
    match schema {
        Value::Object(object) => {
            if let Some(Value::String(reference)) = object.get_mut("$ref")
                && let Some(local) = reference.strip_prefix('#')
            {
                *reference = format!("#/$defs/{component}{local}");
            }
            for value in object.values_mut() {
                scope_refs(value, component);
            }
        }
        Value::Array(array) => {
            for value in array {
                scope_refs(value, component);
            }
        }
        _ => {}
    }
}

fn invalid_schema() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid typed action schema")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn names_escape_underscores_and_reject_length_instead_of_truncating() {
        assert_eq!(tool_name("session.tx").unwrap(), "swb_session_x2E_tx");
        assert_eq!(tool_name("a_b").unwrap(), "swb_a_x5F_b");
        assert_ne!(tool_name("a.b").unwrap(), tool_name("a_x2E_b").unwrap());
        assert_eq!(
            tool_name(&"_".repeat(26)).unwrap_err().code,
            "LIMIT_EXCEEDED"
        );
        assert!(resolve("swb_session_x2e_tx").is_none());
    }

    fn assert_refs(root: &Value, node: &Value) {
        match node {
            Value::Object(object) => {
                if let Some(Value::String(reference)) = object.get("$ref") {
                    let local = reference.strip_prefix('#').expect("local typed schema ref");
                    assert!(root.pointer(local).is_some(), "Unresolved {reference}");
                }
                for value in object.values() {
                    assert_refs(root, value);
                }
            }
            Value::Array(array) => {
                for value in array {
                    assert_refs(root, value);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn every_typed_action_has_a_unique_tool_and_resolved_2020_schema() {
        let mut names = HashSet::new();
        for action in BuiltinAction::ALL {
            let spec = action.spec();
            let tool = tool(&spec).unwrap();
            assert!(names.insert(tool.name.clone()));
            assert_eq!(resolve(&tool.name), Some(action));
            let input = Value::Object(tool.input_schema.as_ref().clone());
            assert_refs(&input, &input);
            assert_eq!(
                input["$schema"],
                "https://json-schema.org/draft/2020-12/schema"
            );
            let target = &input["$defs"]["Wire"]["$defs"]["Target"];
            assert!(target.get("dependentRequired").is_some(), "{target}");
            assert!(target.get("dependencies").is_none());
            let output = Value::Object(tool.output_schema.unwrap().as_ref().clone());
            assert_refs(&output, &output);
            if spec.kind == ActionKind::Action {
                assert_eq!(output, schema_for::<Operation>(SchemaDialect::Draft202012));
            } else {
                assert_eq!(
                    output,
                    serde_json::to_value(
                        action
                            .spec_with_dialect(SchemaDialect::Draft202012)
                            .output_schema
                    )
                    .unwrap()
                );
            }
        }
    }
}
