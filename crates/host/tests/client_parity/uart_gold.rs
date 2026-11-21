//! Verifies the physical sample clock through a signed public-SDK contribution.
use super::*;

const ACTION: &str = "example.terminal.uart.gold";

#[tokio::test]
#[ignore = "Requires pnpm plugin-sdk:fixture and SWB_NODE_RUNTIME_TEST_ROOT"]
async fn native_node_dynamic_uart_gold_preserves_sample_clock_and_source_ranges() {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.cache/plugin-sdk/examples/uart-gold.js");
    let source = std::fs::read(source).expect("Compile the public SDK gold fixture");
    let mut definition = spec();
    definition.action_id = id(ACTION);
    let index = json!({"type":"string","pattern":"^(0|[1-9][0-9]{0,19})$"});
    let positive = json!({"type":"string","pattern":"^[1-9][0-9]{0,8}$"});
    let trace = json!({"type":"string","pattern":"^[01]+$","minLength":1,"maxLength":8192});
    definition.input_schema = serde_json::from_value(json!({
        "type":"object",
        "properties":{
            "sampleClockId":{"type":"string","minLength":1,"maxLength":128},
            "sampleRateHz":positive,
            "sampleStart":index,
            "baud":positive,
            "rx":trace,
            "tx":trace
        },
        "required":["sampleClockId","sampleRateHz","sampleStart","baud","rx","tx"],
        "additionalProperties":false
    }))
    .unwrap();
    let frames = json!({
        "type":"array",
        "items":{
            "type":"object",
            "properties":{
                "byte":{"type":"integer","minimum":0,"maximum":255},
                "sampleStart":index,"sampleEnd":index,
                "startOffsetNs":index,"endOffsetNs":index
            },
            "required":["byte","sampleStart","sampleEnd","startOffsetNs","endOffsetNs"],
            "additionalProperties":false
        }
    });
    definition.output_schema = serde_json::from_value(json!({
        "type":"object",
        "properties":{
            "clock":{
                "type":"object",
                "properties":{
                    "sampleClockId":{"type":"string"},
                    "sampleRateHz":positive,"sampleStart":index,"sampleEnd":index
                },
                "required":["sampleClockId","sampleRateHz","sampleStart","sampleEnd"],
                "additionalProperties":false
            },
            "rx":frames,"tx":frames
        },
        "required":["clock","rx","tx"],
        "additionalProperties":false
    }))
    .unwrap();
    let fixture = Fixture::program(definition, &source).await;
    // Independent waveforms in 16-sample cells. The two lanes start on different samples.
    const RX_0X53: &str = "0110010101";
    const RX_0X81: &str = "0100000011";
    const TX_0XA6: &str = "0011001011";
    let frame = |bits: &str| {
        bits.chars()
            .flat_map(|bit| std::iter::repeat_n(bit, 16))
            .collect::<String>()
    };
    let rx = format!("111{}11111{}1111", frame(RX_0X53), frame(RX_0X81));
    let tx = format!("1111111{}{}", frame(TX_0XA6), "1".repeat(165));
    assert_eq!(rx.len(), 332);
    assert_eq!(tx.len(), 332);
    let params = json!({
        "sampleClockId":"synthetic-analyzer-1",
        "sampleRateHz":"1843200",
        "sampleStart":"9007199254740997",
        "baud":"115200",
        "rx":rx,
        "tx":tx
    });
    let call = fixture.call(&fixture.client, &fixture.target, ACTION, params);
    let accepted = fixture.invoke(&fixture.client, call).await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let result = fixture.result(&fixture.client, &settled).await;
    let expected = json!({
        "clock":{
            "sampleClockId":"synthetic-analyzer-1","sampleRateHz":"1843200",
            "sampleStart":"9007199254740997","sampleEnd":"9007199254741329"
        },
        "rx":[
            {"byte":83,"sampleStart":"9007199254741000","sampleEnd":"9007199254741160",
             "startOffsetNs":"1627","endOffsetNs":"88433"},
            {"byte":129,"sampleStart":"9007199254741165","sampleEnd":"9007199254741325",
             "startOffsetNs":"91145","endOffsetNs":"177951"}
        ],
        "tx":[
            {"byte":166,"sampleStart":"9007199254741004","sampleEnd":"9007199254741164",
             "startOffsetNs":"3797","endOffsetNs":"90603"}
        ]
    });
    assert_eq!(result, expected);
    let archive = fixture.archive.clone();
    let _ = fixture.finish().await;
    eprintln!(
        "uart_gold signed_archive={archive} operation={} clock_and_source={result} clean_shutdown=true",
        accepted.operation_id
    );
}
