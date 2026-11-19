use super::*;

const ACTION_SOURCE: &[u8] = b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',()=>({value:++calls}));return ()=>{};}";

fn assert_activation_budget(input: Value, oversized: bool) -> usize {
    let input_bytes = serde_json::to_vec(&input).unwrap().len();
    let (_profile, proof, spec) =
        action_package_with_input_schema(ACTION_SOURCE, serde_json::from_value(input).unwrap());
    let id = proof.package().manifest.id.clone();
    let backend = backend();
    let registration = backend.activate(proof, || Ok(()));
    if registration.is_ok() {
        if !oversized {
            assert_eq!(
                backend
                    .invoke(id.clone(), action_call(&spec, 7), || Ok(()))
                    .unwrap(),
                json!({"value":1})
            );
        }
        backend.dispose(id.clone(), || Ok(())).unwrap();
    }
    let (_valid_profile, valid_proof, valid_spec) = action_package(ACTION_SOURCE);
    backend.activate(valid_proof, || Ok(())).unwrap();
    let recovered = backend
        .invoke(id, action_call(&valid_spec, 7), || Ok(()))
        .unwrap();
    let report = backend.shutdown();
    assert!(report.reaped && report.error.is_none(), "{report:?}");
    assert_eq!(recovered, json!({"value":1}));
    if oversized {
        assert!(
            matches!(&registration, Err(error) if error.code == "LIMIT_EXCEEDED"),
            "Oversized schema was not rejected before activation: {registration:?}"
        );
    } else {
        assert!(registration.is_ok(), "{registration:?}");
    }
    input_bytes
}

fn reference_graph(contexts: usize, fields: usize) -> Value {
    let properties = (0..fields)
        .map(|index| (format!("p{index}"), json!({"type":"integer"})))
        .collect::<serde_json::Map<_, _>>();
    let branches = (0..contexts)
        .map(|index| json!({"$id":format!("?v={index}"),"$ref":"?root#/$defs/h"}))
        .collect::<Vec<_>>();
    json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "$id":"https://compiler-cost.example.invalid/schema?root",
        "$defs":{"h":{"type":"object","properties":properties}},
        "allOf":branches,
        "type":"object","properties":{"value":{"type":"integer"}},
        "required":["value"],"additionalProperties":false
    })
}

fn owned_anchor_index_input(
    levels: usize,
    key_bytes: usize,
    anchors: usize,
    dynamic: bool,
) -> Value {
    let definitions = (0..anchors)
        .map(|index| {
            let mut anchor = json!({"type":"object"});
            anchor[if dynamic { "$dynamicAnchor" } else { "$anchor" }] = json!(format!("a{index}"));
            (format!("a{index}"), anchor)
        })
        .collect::<serde_json::Map<_, _>>();
    let mut tree = json!({"$defs":definitions});
    for level in 0..levels {
        let key = format!("n{level}_{}", "x".repeat(key_bytes));
        tree = json!({"$defs":{key:tree}});
    }
    json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "$defs":{"unused":tree},
        "type":"object","properties":{"value":{"type":"integer"}},
        "required":["value"],"additionalProperties":false
    })
}

fn assert_index_activation(input: Value, oversized: bool) -> usize {
    let input_bytes = serde_json::to_vec(&input).unwrap().len();
    let (_profile, proof, action) =
        action_package_with_input_schema(ACTION_SOURCE, serde_json::from_value(input).unwrap());
    let id = proof.package().manifest.id.clone();
    let backend = backend();
    let activation = backend.activate(proof, || Ok(()));
    let call = if activation.is_ok() {
        let call = backend.invoke(id.clone(), action_call(&action, 7), || Ok(()));
        backend.dispose(id.clone(), || Ok(())).unwrap();
        Some(call)
    } else {
        None
    };
    let (_valid_profile, valid_proof, valid_action) = action_package(ACTION_SOURCE);
    backend.activate(valid_proof, || Ok(())).unwrap();
    let recovered = backend
        .invoke(id, action_call(&valid_action, 7), || Ok(()))
        .unwrap();
    let report = backend.shutdown();
    assert!(report.reaped && report.error.is_none(), "{report:?}");
    assert_eq!(recovered, json!({"value":1}));
    if oversized {
        assert!(
            matches!(&activation,Err(error) if error.code=="LIMIT_EXCEEDED"),
            "Owned index was not rejected before activation: activation={activation:?} call={call:?}"
        );
    } else {
        assert!(activation.is_ok(), "{activation:?}");
        assert_eq!(call.unwrap().unwrap(), json!({"value":1}));
    }
    input_bytes
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_index_budget_bounds_owned_anchor_pointer_copies() {
    for (levels, key_bytes, anchors, dynamic, oversized) in [
        (2, 32, 4, false, false),
        (32, 2_048, 512, false, true),
        (2, 32, 4, true, false),
        (32, 2_048, 512, true, true),
    ] {
        let input_bytes = assert_index_activation(
            owned_anchor_index_input(levels, key_bytes, anchors, dynamic),
            oversized,
        );
        eprintln!(
            "native_schema_index_owned levels={levels} key_bytes={key_bytes} anchors={anchors} dynamic={dynamic} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_index_budget_checks_prepared_root_aliases_before_publication() {
    for (anchors, root_anchor_bytes, oversized) in [(4, 32, false), (236, 200_000, true)] {
        let mut input = owned_anchor_index_input(32, 2_048, anchors, false);
        input["$id"] = json!("https://prepared-index.example.invalid/schema");
        input["$anchor"] = json!(format!("a{}", "x".repeat(root_anchor_bytes)));
        let input_bytes = assert_index_activation(input, oversized);
        eprintln!(
            "native_schema_index_root_alias anchors={anchors} root_anchor_bytes={root_anchor_bytes} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_index_budget_checks_legacy_ids_before_invalid_ref_validation() {
    for (resources, expected) in [(4, "NODE_SCHEMA_INVALID"), (512, "LIMIT_EXCEEDED")] {
        let branches = (0..resources)
            .map(|index| json!({"$id":format!("?v={index}"),"$ref":null}))
            .collect::<Vec<_>>();
        let input = json!({
            "$schema":"http://json-schema.org/draft-07/schema#",
            "$id":format!("https://invalid-ref-index.example.invalid/{}/", "x".repeat(65_536)),
            "$ref":null,"allOf":branches,
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false
        });
        let input_bytes = serde_json::to_vec(&input).unwrap().len();
        let (_profile, proof, _) =
            action_package_with_input_schema(ACTION_SOURCE, serde_json::from_value(input).unwrap());
        let id = proof.package().manifest.id.clone();
        let backend = backend();
        let result = backend.activate(proof, || Ok(()));
        let (_valid_profile, proof, action) = action_package(ACTION_SOURCE);
        backend.activate(proof, || Ok(())).unwrap();
        let recovered = backend
            .invoke(id, action_call(&action, 7), || Ok(()))
            .unwrap();
        let report = backend.shutdown();
        assert!(report.reaped && report.error.is_none(), "{report:?}");
        assert_eq!(recovered, json!({"value":1}));
        eprintln!(
            "native_schema_index_invalid_ref resources={resources} input_bytes={input_bytes} expected={expected} result={result:?} subsequent_activation_usable=true handler_calls=1"
        );
        assert!(
            matches!(&result,Err(error) if error.code==expected),
            "{result:?}"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_index_budget_preserves_paths_and_unused_data() {
    for (draft, legacy) in [
        ("http://json-schema.org/draft-07/schema#", true),
        ("https://json-schema.org/draft/2020-12/schema", false),
    ] {
        for (key, large_annotation) in [("a/b~é", false), ("", false), ("a/b~é", true), ("", true)]
        {
            let mut leaf = json!({"type":"integer"});
            leaf[if legacy { "$id" } else { "$anchor" }] =
                json!(if legacy { "#value" } else { "value" });
            let mut input = json!({
                "$schema":draft,
                "definitions":{"unused":{"allOf":[{"properties":{key:leaf}}]}},
                "type":"object","properties":{"value":{"$ref":"#value"}},
                "required":["value"],"additionalProperties":false
            });
            if large_annotation {
                let anchors = (0..512)
                    .map(|index| (format!("a{index}"), json!({"$anchor":format!("a{index}")})))
                    .collect::<serde_json::Map<_, _>>();
                let mut data = json!({"$defs":anchors});
                for level in 0..32 {
                    let field = format!("n{level}_{}", "x".repeat(2_048));
                    data = json!({"$defs":{field:data}});
                }
                input["examples"] = json!([data]);
            }
            let input_bytes = assert_activation_budget(input, false);
            eprintln!(
                "native_schema_index_compatibility draft={draft} key={key:?} large_annotation={large_annotation} input_bytes={input_bytes} call_usable=true subsequent_activation_usable=true"
            );
        }
    }
}

fn encoded_pointer_graph(
    levels: usize,
    aliases: usize,
    base_bytes: usize,
    cross_resource: bool,
) -> Value {
    let mut tree = json!({"type":"object"});
    for index in (0..levels).rev() {
        tree = json!({"$id":format!("?v={index}"),"properties":{"next":tree}});
    }
    let mut properties = serde_json::Map::from_iter([("value".into(), json!({"type":"integer"}))]);
    for alias in 0..aliases {
        let mut pointer = String::from(if cross_resource {
            "?v=0#"
        } else {
            "#/$defs/tree"
        });
        for level in 0..levels {
            pointer.push_str(if level == alias {
                "/%70roperties/next"
            } else {
                "/properties/next"
            });
        }
        properties.insert(format!("n{alias}"), json!({"$ref":pointer}));
    }
    json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "$id":format!("https://lookup-budget.example.invalid/{}/", "x".repeat(base_bytes)),
        "$defs":{"tree":tree},"type":"object","properties":properties,
        "required":["value"],"additionalProperties":false
    })
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_lookup_budget_counts_encoded_pointer_prefixes() {
    for (levels, aliases, base_bytes, oversized) in [(4, 4, 4_096, false), (24, 24, 16_384, true)] {
        let input = encoded_pointer_graph(levels, aliases, base_bytes, false);
        eprintln!(
            "native_schema_lookup_before_activation levels={levels} aliases={aliases} base_bytes={base_bytes} input_bytes={}",
            serde_json::to_vec(&input).unwrap().len()
        );
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_lookup_encoded levels={levels} aliases={aliases} base_bytes={base_bytes} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_lookup_budget_reuses_encoded_array_targets() {
    let mut input = encoded_pointer_graph(24, 1, 16_384, false);
    let item = input["properties"]
        .as_object_mut()
        .unwrap()
        .remove("n0")
        .unwrap();
    input["properties"]["rows"] = json!({"type":"array","items":item});
    let (_profile, proof, spec) =
        action_package_with_input_schema(ACTION_SOURCE, serde_json::from_value(input).unwrap());
    let id = proof.package().manifest.id.clone();
    let backend = backend();
    backend.activate(proof, || Ok(())).unwrap();
    let mut call = action_call(&spec, 7);
    call.params = serde_json::from_value(json!({"value":7,"rows":vec![json!({});32]})).unwrap();
    let result = backend.invoke(id, call, || Ok(()));
    let report = backend.shutdown();
    assert!(report.reaped && report.error.is_none(), "{report:?}");
    assert_eq!(result.unwrap(), json!({"value":1}));
    eprintln!(
        "native_schema_lookup_repeated levels=24 aliases=1 base_bytes=16384 array_items=32 call_usable=true handler_calls=1"
    );
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_lookup_budget_counts_cross_resource_prefixes() {
    for (levels, aliases, base_bytes, oversized) in [(4, 4, 4_096, false), (24, 24, 16_384, true)] {
        let input = encoded_pointer_graph(levels, aliases, base_bytes, true);
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_lookup_cross_resource levels={levels} aliases={aliases} base_bytes={base_bytes} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_lookup_budget_preserves_decoded_pointer_tokens() {
    for draft in [
        "http://json-schema.org/draft-07/schema#",
        "https://json-schema.org/draft/2020-12/schema",
    ] {
        for (name, data, reference) in [
            (
                "escaped_unicode",
                json!({"a/b~é":{"type":"integer"}}),
                "#/default/a~1b~0%C3%A9",
            ),
            (
                "array_index",
                json!({"paths":[{"type":"integer"}]}),
                "#/default/paths/%30",
            ),
            (
                "numeric_object",
                json!({"01":{"type":"integer"}}),
                "#/default/%30%31",
            ),
        ] {
            let input = json!({"$schema":draft,"type":"object","default":data,"properties":{"value":{"$ref":reference}},"required":["value"],"additionalProperties":false});
            assert_activation_budget(input, false);
            eprintln!(
                "native_schema_lookup_tokens draft={draft} case={name} call_usable=true subsequent_activation_usable=true handler_calls=1"
            );
        }
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_lookup_budget_uses_actual_prepared_fragment_id_keys() {
    for (references, base_bytes, branch_id, nested_hash, oversized) in [
        (4, 4_096, "#a", false, false),
        (4, 4_096, "?branch#", false, false),
        (96, 32_768, "#a", false, true),
        (4, 4_096, "?branch#x", true, false),
        (96, 32_768, "?branch#x", true, true),
    ] {
        let mut definitions = serde_json::Map::from_iter([(
            "meta".into(),
            json!({"$id":"https://meta.example.invalid/custom","type":"object"}),
        )]);
        let mut properties = serde_json::Map::new();
        for index in 0..references {
            let target = format!("?t{index}");
            definitions.insert(format!("t{index}"), json!({"$id":target,"type":"integer"}));
            properties.insert(format!("p{index}"), json!({"$ref":target}));
        }
        let mut branch = json!({"$schema":"https://meta.example.invalid/custom","$id":branch_id});
        if nested_hash {
            branch["allOf"] = json!([{"$id":"#","properties":properties}]);
        } else {
            branch["properties"] = json!(properties);
        }
        let input = json!({
            "$schema":"http://json-schema.org/draft-07/schema#",
            "$id":format!("https://fragment-lookup.example.invalid/{}/", "x".repeat(base_bytes)),
            "definitions":definitions,
            "allOf":[branch],
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false
        });
        eprintln!(
            "native_schema_lookup_fragment_before_activation references={references} base_bytes={base_bytes} branch_id={branch_id} nested_hash={nested_hash} input_bytes={}",
            serde_json::to_vec(&input).unwrap().len()
        );
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_lookup_fragment references={references} base_bytes={base_bytes} branch_id={branch_id} nested_hash={nested_hash} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_graph_budget_counts_reference_contexts() {
    for (contexts, fields, oversized) in [(4, 8, false), (512, 128, true)] {
        let input = reference_graph(contexts, fields);
        eprintln!(
            "native_schema_graph_before_activation contexts={contexts} fields={fields} input_bytes={}",
            serde_json::to_vec(&input).unwrap().len()
        );
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_graph contexts={contexts} fields={fields} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_graph_budget_preserves_inactive_conditionals() {
    for (keyword, active) in [
        ("then", false),
        ("else", false),
        ("if", false),
        ("then", true),
    ] {
        let mut input = reference_graph(512, 128);
        let branches = input.as_object_mut().unwrap().remove("allOf").unwrap();
        input[keyword] = json!({"allOf":branches});
        if active {
            input["if"] = json!({});
        }
        eprintln!(
            "native_schema_graph_conditional_before_activation keyword={keyword} active={active}"
        );
        let input_bytes = assert_activation_budget(input, active);
        eprintln!(
            "native_schema_graph_conditional keyword={keyword} active={active} input_bytes={input_bytes} activation_limit_rejected={active} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_graph_budget_follows_unknown_dialect_dynamic_references() {
    for (contexts, fields, oversized) in [(4, 8, false), (512, 128, true)] {
        let mut input = reference_graph(contexts, fields);
        input["$defs"]["meta"] = json!({
            "$id":"https://meta.example.invalid/custom",
            "type":"object"
        });
        for branch in input["allOf"].as_array_mut().unwrap() {
            branch.as_object_mut().unwrap().remove("$ref");
            branch["$schema"] = json!("https://meta.example.invalid/custom");
            branch["$dynamicRef"] = json!("?root#/$defs/h");
        }
        eprintln!(
            "native_schema_graph_unknown_before_activation contexts={contexts} fields={fields}"
        );
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_graph_unknown contexts={contexts} fields={fields} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_graph_budget_inherits_vocabulary_within_the_same_draft() {
    for (contexts, fields, oversized) in [(4, 8, false), (512, 128, true)] {
        let mut input = reference_graph(contexts, fields);
        let branches = input.as_object_mut().unwrap().remove("allOf").unwrap();
        input["$defs"]["fullMeta"] = json!({
            "$id":"https://meta.example.invalid/full",
            "$schema":"https://json-schema.org/draft/2020-12/schema"
        });
        input["$defs"]["coreMeta"] = json!({
            "$id":"https://meta.example.invalid/core-only",
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$vocabulary":{"https://json-schema.org/draft/2020-12/vocab/core":true}
        });
        input["allOf"] = json!([{
            "$id":"?outer", "$schema":"https://meta.example.invalid/full",
            "allOf":[{
                "$id":"?inner", "$schema":"https://meta.example.invalid/core-only",
                "allOf":branches
            }]
        }]);
        eprintln!(
            "native_schema_graph_inherited_vocabulary_before_activation contexts={contexts} fields={fields}"
        );
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_graph_inherited_vocabulary contexts={contexts} fields={fields} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_graph_budget_preserves_non_executing_keywords() {
    for (keyword, contexts, fields, oversized) in [
        ("contentSchema", 512, 128, false),
        ("additionalItems", 512, 128, false),
        ("disabledApplicator", 512, 128, false),
        ("enabledAdditionalItems", 4, 8, false),
        ("enabledAdditionalItems", 512, 128, true),
    ] {
        let mut input = reference_graph(contexts, fields);
        let mut branches = input.as_object_mut().unwrap().remove("allOf").unwrap();
        match keyword {
            "disabledApplicator" => {
                input["$defs"]["meta"] = json!({
                    "$id":"https://meta.example.invalid/core-only",
                    "$schema":"https://json-schema.org/draft/2020-12/schema",
                    "$vocabulary":{"https://json-schema.org/draft/2020-12/vocab/core":true}
                });
                input["allOf"] = json!([{
                    "$schema":"https://meta.example.invalid/core-only",
                    "allOf":branches
                }]);
            }
            "additionalItems" | "enabledAdditionalItems" => {
                input["$schema"] = json!("http://json-schema.org/draft-07/schema#");
                let definitions = input.as_object_mut().unwrap().remove("$defs").unwrap();
                input["definitions"] = definitions;
                for branch in branches.as_array_mut().unwrap() {
                    // Draft7忽略$ref的$id同级；独立外层资源才产生不同作用域。
                    let id = branch["$id"].clone();
                    *branch = json!({"$id":id,"allOf":[{"$ref":"?root#/definitions/h"}]});
                }
                input["items"] = if keyword == "additionalItems" {
                    json!({})
                } else {
                    json!([true])
                };
                input["additionalItems"] = json!({"allOf":branches});
            }
            _ => input[keyword] = json!({"allOf":branches}),
        }
        eprintln!(
            "native_schema_graph_keyword_before_activation keyword={keyword} contexts={contexts} fields={fields}"
        );
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_graph_keyword keyword={keyword} contexts={contexts} fields={fields} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_graph_budget_preserves_many_unused_definitions() {
    for definitions in [4, 20_000] {
        let unused = (0..definitions)
            .map(|index| (format!("r{index}"), json!({})))
            .collect::<serde_json::Map<_, _>>();
        let input = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$defs":unused,
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false
        });
        let input_bytes = assert_activation_budget(input, false);
        eprintln!(
            "native_schema_graph_unused definitions={definitions} input_bytes={input_bytes} activation_allowed=true subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_graph_budget_preserves_reused_and_cyclic_targets() {
    for (dialect, recursive) in [
        ("http://json-schema.org/draft-07/schema#", false),
        ("https://json-schema.org/draft/2020-12/schema", false),
        ("http://json-schema.org/draft-07/schema#", true),
        ("https://json-schema.org/draft/2020-12/schema", true),
    ] {
        let mut properties = (0..128)
            .map(|index| (format!("p{index}"), json!({"type":"integer"})))
            .collect::<serde_json::Map<_, _>>();
        if recursive {
            properties.insert("next".into(), json!({"$ref":"#/definitions/h"}));
        }
        let input = json!({
            "$schema":dialect,
            "definitions":{"h":{"type":"object","properties":properties}},
            "allOf":vec![json!({"$ref":"#/definitions/h"});512],
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false
        });
        let input_bytes = assert_activation_budget(input, false);
        eprintln!(
            "native_schema_graph_reuse dialect={dialect} recursive={recursive} references=512 fields=128 input_bytes={input_bytes} activation_allowed=true subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_uri_expansion_budget_rejects_small_source_before_activation() {
    for (base_bytes, resources, oversized) in [(4_096, 4, false), (32_768, 512, true)] {
        let definitions = (0..resources)
            .map(|index| {
                (
                    format!("r{index}"),
                    json!({"$id":format!("?v={index}"),"type":"object"}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let input = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$id":format!("https://registry.example.invalid/{}", "x".repeat(base_bytes)),
            "$defs":definitions,
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false
        });
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_uri_expansion base_bytes={base_bytes} resources={resources} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_uri_budget_follows_referenced_non_schema_json_positions() {
    for (resources, oversized) in [(4, false), (512, true)] {
        let definitions = (0..resources)
            .map(|index| {
                (
                    format!("r{index}"),
                    json!({"$id":format!("?v={index}"),"type":"object"}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let input = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$id":format!("https://pointer-resources.example.invalid/{}", "x".repeat(32_768)),
            "$ref":"#/x-schema",
            "x-schema":{"type":"object","$defs":definitions},
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false
        });
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_pointer_resources resources={resources} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_uri_budget_accepts_bounded_repeated_pointer_targets() {
    let definitions = (0..400)
        .map(|index| {
            (
                format!("r{index}"),
                json!({"$id":format!("?v={index}"),"type":"object"}),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let input = json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "$id":format!("https://pointer-reuse.example.invalid/{}", "x".repeat(32_768)),
        "allOf":vec![json!({"$ref":"#/x-schema"});16],
        "x-schema":{"type":"object","$defs":definitions},
        "type":"object","properties":{"value":{"type":"integer"}},
        "required":["value"],"additionalProperties":false
    });
    let input_bytes = assert_activation_budget(input, false);
    eprintln!(
        "native_schema_pointer_reuse resources=400 repeated_refs=16 input_bytes={input_bytes} activation_allowed=true subsequent_activation_usable=true handler_calls=1"
    );
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_uri_budget_preserves_scopes_in_escaped_pointer_paths() {
    for (dialect, definitions_keyword, short_base, oversized) in [
        (
            "http://json-schema.org/draft-07/schema#",
            "definitions",
            true,
            false,
        ),
        (
            "https://json-schema.org/draft/2020-12/schema",
            "$defs",
            true,
            false,
        ),
        (
            "http://json-schema.org/draft-07/schema#",
            "definitions",
            false,
            true,
        ),
    ] {
        let definitions = (0..512)
            .map(|index| {
                (
                    format!("r{index}"),
                    json!({"$id":format!("?v={index}"),"type":"object"}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let mut target = json!({"$id":"?target","type":"object"});
        target
            .as_object_mut()
            .unwrap()
            .insert(definitions_keyword.into(), Value::Object(definitions));
        let mut container = json!({"$schema":dialect,"schemas":[target]});
        if short_base {
            container.as_object_mut().unwrap().insert(
                "$id".into(),
                json!("https://short-pointer.example.invalid/root.json"),
            );
        }
        let input = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$id":format!("https://pointer-scope.example.invalid/{}", "x".repeat(32_768)),
            "$ref":"#/x~1schema~0pool/schemas/0",
            "x/schema~pool":container,
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false
        });
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_pointer_scope dialect={dialect} short_base={short_base} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_uri_budget_reuses_normally_crawled_relative_id_targets() {
    for resources in [4, 256] {
        let definitions = (0..resources)
            .map(|index| {
                (
                    format!("r{index}"),
                    json!({"$id":format!("?v={index}"),"type":"object"}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let input = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$id":"https://normal-pointer.example.invalid/root.json",
            "$ref":"#/$defs/target",
            "$defs":{"target":{"$id":format!("nested/{}", "x".repeat(32_768)),"type":"object","$defs":definitions}},
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false
        });
        let input_bytes = assert_activation_budget(input, false);
        eprintln!(
            "native_schema_normal_pointer_target resources={resources} input_bytes={input_bytes} activation_allowed=true subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_uri_budget_counts_anchor_discovery_with_relative_root_ids() {
    for (resources, oversized) in [(4, false), (256, true)] {
        let mut definitions = (0..resources)
            .map(|index| {
                (
                    format!("r{index}"),
                    json!({"$id":format!("?v={index}"),"type":"object"}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        definitions.insert("anchorReference".into(), json!({"$ref":"#root"}));
        let input = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$id":format!("nested/{}", "x".repeat(32_768)),
            "$anchor":"root","$defs":definitions,
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false
        });
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_anchor_discovery resources={resources} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_uri_budget_counts_numeric_object_pointer_discovery() {
    for (resources, oversized) in [(4, false), (256, true)] {
        let definitions = (0..resources)
            .map(|index| {
                (
                    format!("r{index}"),
                    json!({"$id":format!("?v={index}"),"type":"object"}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let input = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$id":"https://numeric-pointer.example.invalid/root.json",
            "$ref":"#/$defs/0",
            "$defs":{"0":{"$id":format!("nested/{}", "x".repeat(32_768)),"type":"object","$defs":definitions}},
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false
        });
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_numeric_pointer resources={resources} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_uri_budget_counts_distinct_pending_reference_aliases() {
    for (aliases, oversized) in [(4, false), (512, true)] {
        let input = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$id":format!("https://aliases.example.invalid/{}/?root", "x".repeat(24_576)),
            "$defs":{"h":{"type":"object"}},
            "allOf":(0..aliases).map(|index| json!({"$ref":format!("{}?root#/$defs/h", "./".repeat(index))})).collect::<Vec<_>>(),
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false
        });
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_pending_aliases aliases={aliases} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_uri_budget_preserves_unused_standard_meta_references() {
    for references in [4, 448] {
        let definitions=(0..references).map(|index| (format!("m{index}"),json!({"$ref":format!("https://json-schema.org/draft/2020-12/{}schema", "./".repeat(index))}))).collect::<serde_json::Map<_, _>>();
        let input = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$id":format!("https://meta-resources.example.invalid/{}", "x".repeat(81_920)),
            "$defs":definitions,
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false
        });
        let input_bytes = serde_json::to_vec(&input).unwrap().len();
        let (_profile, proof, spec) =
            action_package_with_input_schema(ACTION_SOURCE, serde_json::from_value(input).unwrap());
        let id = proof.package().manifest.id.clone();
        let backend = backend();
        let registration = backend.activate(proof, || Ok(()));
        let observed = if registration.is_ok() {
            let result = backend.invoke(id.clone(), action_call(&spec, 7), || Ok(()));
            backend.dispose(id, || Ok(())).unwrap();
            Some(result)
        } else {
            None
        };
        let report = backend.shutdown();
        assert!(report.reaped && report.error.is_none(), "{report:?}");
        assert!(
            registration.is_ok(),
            "Unused standard meta references were rejected: {registration:?}"
        );
        assert_eq!(observed.unwrap().unwrap(), json!({"value":1}));
        eprintln!(
            "native_schema_standard_meta_references references={references} input_bytes={input_bytes} unused_definitions_preserved=true call_usable=true"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_uri_budget_bounds_unknown_meta_resource_resolution() {
    for (resources, oversized) in [(4, false), (144, true)] {
        let mut definitions=(0..resources).map(|index| (format!("r{index}"),json!({"$id":format!("?v={index}"),"$schema":"https://meta.example.invalid/custom","type":"object"}))).collect::<serde_json::Map<_, _>>();
        definitions.insert(
            "meta".into(),
            json!({"$id":"https://meta.example.invalid/custom","type":"object"}),
        );
        let input = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$id":format!("https://unknown-meta.example.invalid/{}", "x".repeat(65_536)),
            "$defs":definitions,
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false
        });
        let input_bytes = assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_unknown_meta resources={resources} input_bytes={input_bytes} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_resource_budget_preserves_short_uris_and_default_data() {
    for (dialect, definitions_keyword) in [
        ("http://json-schema.org/draft-07/schema#", "definitions"),
        ("https://json-schema.org/draft/2020-12/schema", "$defs"),
    ] {
        for annotation in [false, true] {
            let definitions = (0..512)
                .map(|index| {
                    (
                        format!("r{index}"),
                        json!({"$id":format!("?v={index}"),"type":"object"}),
                    )
                })
                .collect::<serde_json::Map<_, _>>();
            let base_bytes = if annotation { 32_768 } else { 32 };
            let mut input = json!({
                "$schema":dialect,
                "$id":format!("https://resources.example.invalid/{}", "x".repeat(base_bytes)),
                "type":"object","properties":{"value":{"type":"integer"}},
                "required":["value"],"additionalProperties":false
            });
            input.as_object_mut().unwrap().insert(
                if annotation {
                    "default"
                } else {
                    definitions_keyword
                }
                .into(),
                Value::Object(definitions),
            );
            let (_profile, proof, spec) = action_package_with_input_schema(
                ACTION_SOURCE,
                serde_json::from_value(input).unwrap(),
            );
            let id = proof.package().manifest.id.clone();
            let backend = backend();
            backend.activate(proof, || Ok(())).unwrap();
            let result = backend
                .invoke(id.clone(), action_call(&spec, 7), || Ok(()))
                .unwrap();
            backend.dispose(id, || Ok(())).unwrap();
            let report = backend.shutdown();
            assert!(report.reaped && report.error.is_none(), "{report:?}");
            assert_eq!(result, json!({"value":1}));
            eprintln!(
                "native_schema_resource_compatibility dialect={dialect} default_data={annotation} base_bytes={base_bytes} resources=512 call_usable=true"
            );
        }
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_schema_node_budget_rejects_oversized_definitions_before_activation() {
    for (entries, oversized) in [(1_000, false), (55_000, true)] {
        let input = json!({
            "type":"object","properties":{"value":{"type":"integer","enum":(0..entries).collect::<Vec<_>>() }},
            "required":["value"],"additionalProperties":false
        });
        assert_activation_budget(input, oversized);
        eprintln!(
            "native_schema_compilation_nodes enum_entries={entries} activation_limit_rejected={oversized} subsequent_activation_usable=true handler_calls=1"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_action_schemas_and_private_failure_keep_control_usable() {
    let (_profile, proof, spec) = action_package(
        br#"
export function register(context) {
  let calls=0;
  context.actions.register('example.terminal.compute', call => {
    calls++;
    if(call.params.value===13) return {value:'invalid'};
    if(call.params.value===17) throw new Error('fixture-private-action-detail');
    return {value:calls};
  });
  return () => {};
}
"#,
    );
    let id = proof.package().manifest.id.clone();
    let backend = backend();
    backend.activate(proof, || Ok(())).unwrap();
    let mut invalid = action_call(&spec, 1);
    invalid.params = serde_json::from_value(json!({"value":"invalid"})).unwrap();
    assert_eq!(
        backend
            .invoke(id.clone(), invalid, || Ok(()))
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    assert_eq!(
        backend
            .invoke(id.clone(), action_call(&spec, 7), || Ok(()))
            .unwrap(),
        json!({"value":1})
    );
    assert_eq!(
        backend
            .invoke(id.clone(), action_call(&spec, 13), || Ok(()))
            .unwrap_err()
            .code,
        "NODE_ACTION_FAILED"
    );
    let private = backend
        .invoke(id.clone(), action_call(&spec, 17), || Ok(()))
        .unwrap_err();
    assert_eq!(private.code, "NODE_ACTION_FAILED");
    assert!(
        !serde_json::to_string(&private)
            .unwrap()
            .contains("fixture-private-action-detail")
    );
    assert_eq!(
        backend
            .invoke(id.clone(), action_call(&spec, 7), || Ok(()))
            .unwrap(),
        json!({"value":4})
    );
    backend.dispose(id, || Ok(())).unwrap();
    let report = backend.shutdown();
    assert!(report.reaped && report.error.is_none(), "{report:?}");
    assert!(String::from_utf8_lossy(&report.stderr).contains("fixture-private-action-detail"));
}
