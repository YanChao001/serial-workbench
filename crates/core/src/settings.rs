use crate::{Bytes, U64};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

macro_rules! choice {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
        #[serde(rename_all = "lowercase")]
        pub enum $name { $($variant),+ }
    };
}
choice!(Language { Zh, En });
choice!(Theme {
    Light,
    Dark,
    System
});
choice!(Accent {
    Neutral,
    Indigo,
    Blue,
    Cyan,
    Teal,
    Emerald,
    Lime,
    Amber,
    Orange,
    Rose,
    Pink,
    Violet,
    Slate,
    Custom
});
choice!(Radius { Sharp, Soft, Round });
choice!(Font {
    Geist,
    System,
    Serif,
    Mono
});
choice!(FontSize { Sm, Md, Lg });
choice!(Motion { Full, Reduced });
choice!(NetworkMode { System, Direct });
choice!(BackgroundPreset {
    Plain,
    Aurora,
    Dune,
    Inkwash,
    Starlight,
    Sakura,
    Moonlit,
    Botanical,
    Cloudscape
});
choice!(BackgroundFit { Cover, Contain });
choice!(TerminalMode { Text, Hex });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum BackgroundSelection {
    Preset {
        value: BackgroundPreset,
    },
    Bundled {
        id: crate::Id,
    },
    Media {
        reference: crate::ObjectRef,
        fit: BackgroundFit,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LineEnding {
    None {},
    Cr {},
    Lf {},
    Crlf {},
    Custom { bytes_base64: Bytes },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSettings {
    pub receive_mode: TerminalMode,
    pub send_mode: TerminalMode,
    pub line_ending: LineEnding,
}
impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            receive_mode: TerminalMode::Text,
            send_mode: TerminalMode::Text,
            line_ending: LineEnding::None {},
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedSettings {
    pub language: Language,
    pub theme: Theme,
    pub accent: Accent,
    #[serde(deserialize_with = "accent_color")]
    #[schemars(regex(pattern = "^#[0-9A-Fa-f]{6}$"))]
    #[specta(type = String)]
    pub custom_accent: String,
    pub radius: Radius,
    pub font: Font,
    pub font_size: FontSize,
    pub background: BackgroundSelection,
    #[serde(deserialize_with = "intensity")]
    #[schemars(range(min = 0, max = 100))]
    #[specta(type = u8)]
    pub background_intensity: u8,
    pub motion: Motion,
    pub auto_check_updates: bool,
    pub network_mode: NetworkMode,
    pub run_in_background: bool,
    pub terminal: TerminalSettings,
}
fn accent_color<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    if value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|c| c.is_ascii_hexdigit())
    {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("Invalid accent color"))
    }
}
fn intensity<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u8, D::Error> {
    let value = u8::deserialize(d)?;
    if value <= 100 {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("Invalid background intensity"))
    }
}
impl Default for SharedSettings {
    fn default() -> Self {
        Self {
            language: Language::Zh,
            theme: Theme::Dark,
            accent: Accent::Lime,
            custom_accent: "#7C3AED".into(),
            radius: Radius::Soft,
            font: Font::Geist,
            font_size: FontSize::Md,
            background: BackgroundSelection::Preset {
                value: BackgroundPreset::Plain,
            },
            background_intensity: 50,
            motion: Motion::Full,
            auto_check_updates: true,
            network_mode: NetworkMode::System,
            run_in_background: false,
            terminal: TerminalSettings::default(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsSnapshot {
    pub revision: U64,
    pub value: SharedSettings,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsSaveParams {
    pub value: SharedSettings,
}
