use std::{collections::HashMap, sync::OnceLock};

#[derive(serde::Deserialize)]
struct Dictionary {
    entries: Vec<(String, String)>,
    #[serde(rename = "variantEntries")]
    variants: Vec<(String, String)>,
}

type Groups = HashMap<char, Vec<(String, String)>>;

pub(crate) fn simplify(input: &str) -> String {
    static STAGES: OnceLock<(Groups, Groups)> = OnceLock::new();
    let (standard, variants) = STAGES.get_or_init(|| {
        let dictionary: Dictionary =
            serde_json::from_str(include_str!("../../src/core/opencc/t2s.json"))
                .expect("bundled OpenCC dictionary must be valid");
        (
            conversion_groups(dictionary.entries),
            conversion_groups(dictionary.variants),
        )
    });
    convert(&convert(input, standard), variants)
}

fn conversion_groups(entries: Vec<(String, String)>) -> Groups {
    let mut groups = Groups::new();
    for (source, target) in entries {
        if let Some(first) = source.chars().next() {
            groups.entry(first).or_default().push((source, target));
        }
    }
    for group in groups.values_mut() {
        group.sort_by_key(|(source, _)| std::cmp::Reverse(source.len()));
    }
    groups
}

fn convert(input: &str, groups: &Groups) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(first) = rest.chars().next() {
        if let Some((source, target)) = groups.get(&first).and_then(|group| {
            group
                .iter()
                .find(|(source, _)| rest.starts_with(source.as_str()))
        }) {
            output.push_str(target);
            rest = &rest[source.len()..];
        } else {
            output.push(first);
            rest = &rest[first.len_utf8()..];
        }
    }
    output
}

pub(crate) fn simplify_transcription_json(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                simplify_transcription_json(item);
            }
        }
        serde_json::Value::Object(object) => {
            for (key, item) in object {
                if key == "text" {
                    if let Some(text) = item.as_str() {
                        *item = serde_json::Value::String(simplify(text));
                        continue;
                    }
                }
                simplify_transcription_json(item);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_dictionary_converts_phrases_and_preserves_english() {
        for (input, expected) in [
            (
                "生活處處藏著溫柔與美好，平凡的日常裡，總有細碎的溫暖治癒人心",
                "生活处处藏着温柔与美好，平凡的日常里，总有细碎的温暖治愈人心",
            ),
            (
                "(無法接受) (視頻) 終於釋懼了溫暖",
                "(无法接受) (视频) 终于释惧了温暖",
            ),
            ("乾坤 乾燥 乾隆 頭髮 發現", "乾坤 干燥 乾隆 头发 发现"),
            (
                "ToolKnit 語音視訊與 English 𠀀",
                "ToolKnit 语音视讯与 English 𠀀",
            ),
            ("藏著 顯著 显著 著作 著名", "藏着 显著 显著 著作 著名"),
            ("什么 怎么 幺 乾图 毕昇 於潜", "什么 怎么 幺 乾图 毕昇 於潜"),
        ] {
            assert_eq!(simplify(input), expected);
            assert_eq!(simplify(expected), expected);
        }
        let dictionary: Dictionary = serde_json::from_str(include_str!("../../src/core/opencc/t2s.json")).unwrap();
        for (source, _) in dictionary.entries.into_iter().chain(dictionary.variants) {
            let once = simplify(&source);
            assert_eq!(simplify(&once), once, "repeated conversion changed {source}");
        }
    }

    #[test]
    fn structured_conversion_leaves_metadata_untouched() {
        let mut value = serde_json::json!({"file":"聲音.wav", "transcription":[{"text":"總有溫暖", "offsets":{"from":123}, "tokens":[{"text":"視頻", "id":42}]}]});
        simplify_transcription_json(&mut value);
        assert_eq!(value["file"], "聲音.wav");
        assert_eq!(value["transcription"][0]["text"], "总有温暖");
        assert_eq!(value["transcription"][0]["offsets"]["from"], 123);
        assert_eq!(value["transcription"][0]["tokens"][0]["text"], "视频");
        assert_eq!(value["transcription"][0]["tokens"][0]["id"], 42);
    }
}
