//! Temporary probe for the failing runtime template assertion.
use cursor_server::cursor::prompting::{Mode, PromptAssets, PromptCompiler};
use std::collections::BTreeMap;

#[test]
fn probe_runtime_render() {
    let compiler = PromptCompiler::new(
        PromptAssets::load(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("prompt/cursor")
                .as_path(),
        )
        .unwrap(),
    );
    let values = BTreeMap::from([
        ("OPEN_FILES", String::new()),
        ("SELECTED_CONTEXT", String::new()),
        ("ACTION_CONTEXT", String::new()),
        ("TIMESTAMP", "ts".into()),
        ("USER_QUERY", "question".into()),
        ("DEBUG_SERVER_ENDPOINT", "http://debug".into()),
        ("DEBUG_LOG_PATH", "/tmp/debug.log".into()),
        ("DEBUG_SESSION_ID", "session".into()),
    ]);
    for (mode, marker) in [
        (Mode::Agent, "You are still in **Agent Mode**"),
        (Mode::Ask, "Ask mode is active."),
        (Mode::Plan, "Plan mode is active."),
        (Mode::Debug, "You are now in **DEBUG MODE**"),
        (Mode::Multitask, "The user has engaged **Multitask Mode**"),
    ] {
        let rendered = compiler.runtime_message(mode, &values).unwrap();
        let has_marker = rendered.contains(marker);
        let has_uq = rendered.contains(
            "<user_query>
question
</user_query>",
        );
        println!(
            "MODE {:?} marker={} user_query={}",
            mode, has_marker, has_uq
        );
        if !has_marker || !has_uq {
            println!("---- rendered start ----");
            println!("{}", &rendered[..rendered.len().min(1200)]);
            println!("---- rendered end ----");
        }
    }
}
