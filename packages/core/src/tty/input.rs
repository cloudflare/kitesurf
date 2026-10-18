// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Parses terminal keyboard, mouse, and wheel input into page-facing events.

use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mods {
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
    pub meta: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyPhase {
    Press,
    Release,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MousePhase {
    Down,
    Up,
    Move,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WheelDir {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Key {
        key: String,
        code: String,
        key_code: u32,
        text: String,
        mods: Mods,
        phase: KeyPhase,
        ctrl_char: Option<char>,
    },
    Mouse {
        x: i32,
        y: i32,
        phase: MousePhase,
    },
    Wheel {
        x: i32,
        y: i32,
        dir: WheelDir,
    },
}

fn describe(cp: u32) -> (String, String, u32) {
    let named = |k: &str, c: &str, v: u32| (k.to_string(), c.to_string(), v);
    match cp {
        27 => return named("Escape", "Escape", 27),
        13 => return named("Enter", "Enter", 13),
        9 => return named("Tab", "Tab", 9),
        127 => return named("Backspace", "Backspace", 8),
        32 => return named(" ", "Space", 32),
        57358 => return named("CapsLock", "CapsLock", 20),
        57414 => return named("Enter", "NumpadEnter", 13),
        57441 | 57447 => return named("Shift", "ShiftLeft", 16),
        57442 | 57448 => return named("Control", "ControlLeft", 17),
        57443 | 57449 => return named("Alt", "AltLeft", 18),
        57444 => return named("Meta", "MetaLeft", 91),
        57450 => return named("Meta", "MetaRight", 92),
        _ => {}
    }
    if (57364..=57375).contains(&cp) {
        let n = cp - 57363;
        return (format!("F{n}"), format!("F{n}"), 111 + n);
    }
    let ch = char::from_u32(cp).unwrap_or('\u{fffd}');
    match cp {
        0x61..=0x7a => (
            ch.to_string(),
            format!("Key{}", ch.to_ascii_uppercase()),
            cp - 32,
        ),
        0x41..=0x5a => (ch.to_string(), format!("Key{ch}"), cp),
        0x30..=0x39 => (ch.to_string(), format!("Digit{ch}"), cp),
        _ => (ch.to_string(), String::new(), cp),
    }
}

fn legacy_final(f: u8) -> Option<(&'static str, &'static str, u32)> {
    Some(match f {
        b'A' => ("ArrowUp", "ArrowUp", 38),
        b'B' => ("ArrowDown", "ArrowDown", 40),
        b'C' => ("ArrowRight", "ArrowRight", 39),
        b'D' => ("ArrowLeft", "ArrowLeft", 37),
        b'H' => ("Home", "Home", 36),
        b'F' => ("End", "End", 35),
        b'P' => ("F1", "F1", 112),
        b'Q' => ("F2", "F2", 113),
        b'R' => ("F3", "F3", 114),
        b'S' => ("F4", "F4", 115),
        _ => return None,
    })
}

fn legacy_tilde(n: u32) -> Option<(&'static str, &'static str, u32)> {
    Some(match n {
        2 => ("Insert", "Insert", 45),
        3 => ("Delete", "Delete", 46),
        5 => ("PageUp", "PageUp", 33),
        6 => ("PageDown", "PageDown", 34),
        11 => ("F1", "F1", 112),
        12 => ("F2", "F2", 113),
        13 => ("F3", "F3", 114),
        14 => ("F4", "F4", 115),
        15 => ("F5", "F5", 116),
        17 => ("F6", "F6", 117),
        18 => ("F7", "F7", 118),
        19 => ("F8", "F8", 119),
        20 => ("F9", "F9", 120),
        21 => ("F10", "F10", 121),
        23 => ("F11", "F11", 122),
        24 => ("F12", "F12", 123),
        _ => return None,
    })
}

fn mods_of(field: Option<&str>) -> Mods {
    let bits = field
        .and_then(|f| f.split(':').next())
        .and_then(|f| f.parse::<u32>().ok())
        .unwrap_or(1)
        .saturating_sub(1);
    Mods {
        shift: bits & 1 != 0,
        alt: bits & 2 != 0,
        ctrl: bits & 4 != 0,
        meta: bits & 8 != 0,
    }
}

fn phase_of(field: Option<&str>) -> KeyPhase {
    let ev = field
        .and_then(|f| f.split(':').nth(1))
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(1);
    if ev == 3 {
        KeyPhase::Release
    } else {
        KeyPhase::Press
    }
}

fn key_event(
    key: String,
    code: String,
    key_code: u32,
    text: String,
    mods: Mods,
    phase: KeyPhase,
) -> Event {
    let ctrl_char = if mods.ctrl && key.chars().count() == 1 {
        key.chars().next().map(|c| c.to_ascii_lowercase())
    } else {
        None
    };
    Event::Key {
        key,
        code,
        key_code,
        text,
        mods,
        phase,
        ctrl_char,
    }
}

pub fn decode(buf: &[u8]) -> (Vec<Event>, usize) {
    let mut events = Vec::new();
    let mut i = 0usize;
    let n = buf.len();
    while i < n {
        let b = buf[i];
        if b != 0x1b {
            match b {
                0x0d => {
                    events.push(key_event(
                        "Enter".into(),
                        "Enter".into(),
                        13,
                        "\r".into(),
                        Mods::default(),
                        KeyPhase::Press,
                    ));
                    i += 1;
                }
                0x09 => {
                    events.push(key_event(
                        "Tab".into(),
                        "Tab".into(),
                        9,
                        "\t".into(),
                        Mods::default(),
                        KeyPhase::Press,
                    ));
                    i += 1;
                }
                0x7f => {
                    events.push(key_event(
                        "Backspace".into(),
                        "Backspace".into(),
                        8,
                        String::new(),
                        Mods::default(),
                        KeyPhase::Press,
                    ));
                    i += 1;
                }
                0x00..=0x1a => {
                    let (k, c, v) = describe(b as u32 + 96);
                    events.push(key_event(
                        k,
                        c,
                        v,
                        String::new(),
                        Mods {
                            ctrl: true,
                            ..Default::default()
                        },
                        KeyPhase::Press,
                    ));
                    i += 1;
                }
                _ => {
                    let len = utf8_len(b);
                    if i + len > n {
                        return (events, i);
                    }
                    let Some((s, ch)) = std::str::from_utf8(&buf[i..i + len])
                        .ok()
                        .and_then(|s| Some((s, s.chars().next()?)))
                    else {
                        i += 1;
                        continue;
                    };
                    let cp = ch as u32;
                    let (k, c, v) = describe(cp);
                    events.push(key_event(
                        k,
                        c,
                        v,
                        s.to_string(),
                        Mods::default(),
                        KeyPhase::Press,
                    ));
                    i += len;
                }
            }
            continue;
        }

        if i + 1 >= n {
            return (events, i);
        }
        if buf[i + 1] == b'O' {
            if i + 2 >= n {
                return (events, i);
            }
            let f = buf[i + 2];
            i += 3;
            if let Some((k, c, v)) = legacy_final(f) {
                events.push(key_event(
                    k.into(),
                    c.into(),
                    v,
                    String::new(),
                    Mods::default(),
                    KeyPhase::Press,
                ));
            }
            continue;
        }

        if buf[i + 1] != b'[' {
            let b1 = buf[i + 1];
            if b1 == 0x1b {
                events.push(key_event(
                    "Escape".into(),
                    "Escape".into(),
                    27,
                    String::new(),
                    Mods::default(),
                    KeyPhase::Press,
                ));
                i += 2;
                continue;
            }
            let alt = Mods {
                alt: true,
                ..Default::default()
            };
            if b1 == 0x7f {
                events.push(key_event(
                    "Backspace".into(),
                    "Backspace".into(),
                    8,
                    String::new(),
                    alt,
                    KeyPhase::Press,
                ));
                i += 2;
                continue;
            }
            let len = utf8_len(b1);
            if i + 1 + len > n {
                return (events, i);
            }
            let Ok(sub) = std::str::from_utf8(&buf[i + 1..i + 1 + len]) else {
                i += 2;
                continue;
            };
            let ch = sub.chars().next().unwrap_or('\u{fffd}');
            let (k, c, v) = describe(ch as u32);
            events.push(key_event(k, c, v, String::new(), alt, KeyPhase::Press));
            i += 1 + len;
            continue;
        }

        let mut j = i + 2;
        while j < n && !(0x40..=0x7e).contains(&buf[j]) {
            j += 1;
        }
        if j >= n {
            return (events, i);
        }
        let final_b = buf[j];
        let body = String::from_utf8_lossy(&buf[i + 2..j]).into_owned();
        i = j + 1;

        match final_b {
            b'M' | b'm' => {
                if let Some(ev) = decode_mouse(&body, final_b == b'M') {
                    events.push(ev);
                }
            }
            b'u' => {
                if let Some(ev) = decode_csi_u(&body) {
                    events.push(ev);
                }
            }
            b'~' => {
                let mut it = body.split(';');
                let n0 = it.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
                if let Some((k, c, v)) = legacy_tilde(n0) {
                    let mod_field = it.next();
                    events.push(key_event(
                        k.into(),
                        c.into(),
                        v,
                        String::new(),
                        mods_of(mod_field),
                        phase_of(mod_field),
                    ));
                }
            }
            _ => {
                if final_b == b'Z' && body.is_empty() {
                    events.push(key_event(
                        "Tab".into(),
                        "Tab".into(),
                        9,
                        String::new(),
                        Mods {
                            shift: true,
                            ..Default::default()
                        },
                        KeyPhase::Press,
                    ));
                    continue;
                }
                let first = body.split(';').next().unwrap_or("");
                if matches!(final_b, b'P' | b'Q' | b'R' | b'S') && !first.is_empty() && first != "1"
                {
                    continue;
                }
                if let Some((k, c, v)) = legacy_final(final_b) {
                    let mod_field = body.split(';').nth(1);
                    events.push(key_event(
                        k.into(),
                        c.into(),
                        v,
                        String::new(),
                        mods_of(mod_field),
                        phase_of(mod_field),
                    ));
                }
            }
        }
    }
    (events, n)
}

fn utf8_len(b: u8) -> usize {
    if b >= 0xf0 {
        4
    } else if b >= 0xe0 {
        3
    } else if b >= 0xc0 {
        2
    } else {
        1
    }
}

fn decode_csi_u(body: &str) -> Option<Event> {
    let mut fields = body.split(';');
    let key_field = fields.next()?;
    let cp: u32 = key_field.split(':').next()?.parse().ok()?;
    let mod_field = fields.next();
    let mods = mods_of(mod_field);
    let phase = phase_of(mod_field);
    let (key, code, key_code) = describe(cp);
    let text = match fields.next() {
        Some(t) if !t.is_empty() => t
            .split(':')
            .filter_map(|c| c.parse::<u32>().ok().and_then(char::from_u32))
            .collect(),
        _ if !mods.ctrl && !mods.meta && key.chars().count() == 1 => {
            if mods.shift {
                key.to_uppercase()
            } else {
                key.clone()
            }
        }
        _ => String::new(),
    };
    Some(key_event(key, code, key_code, text, mods, phase))
}

fn decode_mouse(body: &str, pressed: bool) -> Option<Event> {
    let body = body.strip_prefix('<')?;
    let mut it = body.split(';');
    let btn: u32 = it.next()?.parse().ok()?;
    let x: i32 = it.next()?.parse().ok()?;
    let y: i32 = it.next()?.parse().ok()?;
    if btn & 64 != 0 {
        let dir = match btn & 3 {
            0 => WheelDir::Up,
            1 => WheelDir::Down,
            2 => WheelDir::Left,
            _ => WheelDir::Right,
        };
        return Some(Event::Wheel { x, y, dir });
    }
    let phase = if btn & 32 != 0 {
        MousePhase::Move
    } else if pressed {
        MousePhase::Down
    } else {
        MousePhase::Up
    };
    Some(Event::Mouse { x, y, phase })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(s: &str) -> Vec<Event> {
        let (e, consumed) = decode(s.as_bytes());
        assert_eq!(consumed, s.len(), "expected the whole buffer consumed");
        e
    }

    #[test]
    fn csi_u_carries_the_release_event_type() {
        match &ev("\x1b[97;1:3u")[0] {
            Event::Key {
                key,
                code,
                key_code,
                phase,
                ..
            } => {
                assert_eq!(key, "a");
                assert_eq!(code, "KeyA");
                assert_eq!(*key_code, 65);
                assert_eq!(*phase, KeyPhase::Release);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn associated_text_wins_over_the_key_name() {
        match &ev("\x1b[50;2;64u")[0] {
            Event::Key {
                key, text, mods, ..
            } => {
                assert_eq!(key, "2");
                assert_eq!(text, "@");
                assert!(mods.shift);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn ctrl_chord_resolves_on_both_encodings() {
        for src in ["\x1b[99;5u", "\x03"] {
            match &ev(src)[0] {
                Event::Key {
                    ctrl_char, mods, ..
                } => {
                    assert_eq!(*ctrl_char, Some('c'), "{src:?}");
                    assert!(mods.ctrl);
                }
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn a_legacy_release_is_not_a_second_press() {
        let e = ev("\x1b[1;1A\x1b[1;1:3A");
        let phases: Vec<_> = e
            .iter()
            .map(|x| match x {
                Event::Key { key, phase, .. } => {
                    assert_eq!(key, "ArrowUp");
                    *phase
                }
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(phases, vec![KeyPhase::Press, KeyPhase::Release]);
    }

    #[test]
    fn a_tilde_key_release_is_also_a_release() {
        let e = ev("\x1b[3;1:3~");
        match &e[0] {
            Event::Key { key, phase, .. } => {
                assert_eq!(key, "Delete");
                assert_eq!(*phase, KeyPhase::Release);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn arrows_decode_from_legacy_finals() {
        let e = ev("\x1b[A\x1b[1;2B");
        match (&e[0], &e[1]) {
            (Event::Key { key: a, .. }, Event::Key { key: b, mods, .. }) => {
                assert_eq!(a, "ArrowUp");
                assert_eq!(b, "ArrowDown");
                assert!(mods.shift);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn shift_tab_decodes_in_legacy_and_kitty_modes() {
        for src in ["\x1b[Z", "\x1b[9;2u"] {
            match &ev(src)[0] {
                Event::Key {
                    key, code, mods, ..
                } => {
                    assert_eq!(key, "Tab");
                    assert_eq!(code, "Tab");
                    assert!(mods.shift);
                }
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn sgr_mouse_press_release_motion() {
        let e = ev("\x1b[<0;100;200M\x1b[<0;100;200m\x1b[<35;101;201M");
        assert_eq!(
            e,
            vec![
                Event::Mouse {
                    x: 100,
                    y: 200,
                    phase: MousePhase::Down
                },
                Event::Mouse {
                    x: 100,
                    y: 200,
                    phase: MousePhase::Up
                },
                Event::Mouse {
                    x: 101,
                    y: 201,
                    phase: MousePhase::Move
                },
            ]
        );
    }

    #[test]
    fn wheel_buttons_decode_to_directions() {
        let e = ev("\x1b[<64;5;5M\x1b[<65;5;5M\x1b[<66;5;5M");
        let dirs: Vec<_> = e
            .iter()
            .map(|x| match x {
                Event::Wheel { dir, .. } => *dir,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(dirs, vec![WheelDir::Up, WheelDir::Down, WheelDir::Left]);
    }

    #[test]
    fn split_sequence_is_held_not_mangled() {
        let whole = b"\x1b[<0;12;34M";
        let (e, consumed) = decode(&whole[..5]);
        assert!(e.is_empty());
        assert_eq!(consumed, 0);
        let (e, consumed) = decode(whole);
        assert_eq!(consumed, whole.len());
        assert_eq!(
            e[0],
            Event::Mouse {
                x: 12,
                y: 34,
                phase: MousePhase::Down
            }
        );
    }

    #[test]
    fn multibyte_char_is_one_key_and_a_truncation_is_held() {
        match &ev("é")[0] {
            Event::Key { text, .. } => assert_eq!(text, "é"),
            other => panic!("{other:?}"),
        }
        let whole = "é".as_bytes();
        let (e, consumed) = decode(&whole[..1]);
        assert!(e.is_empty());
        assert_eq!(consumed, 0);
    }

    fn as_key(e: &Event) -> (&str, &str, u32, &str, KeyPhase, Option<char>) {
        match e {
            Event::Key {
                key,
                code,
                key_code,
                text,
                phase,
                ctrl_char,
                ..
            } => (key, code, *key_code, text, *phase, *ctrl_char),
            other => panic!("expected a key event, got {other:?}"),
        }
    }

    #[test]
    fn enter_arrives_as_cr_not_lf() {
        let cr = ev("\r");
        let (key, _, _, _, _, _) = as_key(&cr[0]);
        assert_eq!(key, "Enter");
        let lf = ev("\n");
        let (_, _, _, _, _, ctrl) = as_key(&lf[0]);
        assert_eq!(ctrl, Some('j'));
    }

    #[test]
    fn plain_text_carries_through() {
        let e = ev("ab");
        let (k0, _, _, t0, _, _) = as_key(&e[0]);
        let (k1, _, _, t1, _, _) = as_key(&e[1]);
        assert_eq!((k0, t0, k1, t1), ("a", "a", "b", "b"));
    }

    use crate::tty::grid::osc52;

    #[test]
    fn osc52_carries_base64_and_terminates() {
        assert_eq!(osc52("hi"), "\x1b]52;c;aGk=\x07");
        assert_eq!(osc52("abc"), "\x1b]52;c;YWJj\x07");
    }

    fn keys(bytes: &[u8]) -> Vec<(String, Mods)> {
        let (evs, _) = decode(bytes);
        evs.into_iter()
            .filter_map(|e| match e {
                Event::Key { key, mods, .. } => Some((key, mods)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn option_delete_is_alt_backspace_not_escape() {
        let k = keys(b"\x1b\x7f");
        assert_eq!(k.len(), 1, "expected one key, got {k:?}");
        assert_eq!(k[0].0, "Backspace");
        assert!(k[0].1.alt, "alt not set");
    }

    #[test]
    fn option_b_and_f_are_alt_chords_with_no_text() {
        let (evs, _) = decode(b"\x1bb\x1bf");
        let text: Vec<_> = evs
            .iter()
            .filter_map(|e| match e {
                Event::Key {
                    key, text, mods, ..
                } => Some((key.clone(), text.clone(), mods.alt)),
                _ => None,
            })
            .collect();
        assert_eq!(text.len(), 2, "{text:?}");
        assert_eq!(text[0], ("b".into(), String::new(), true));
        assert_eq!(text[1], ("f".into(), String::new(), true));
    }

    #[test]
    fn a_lone_trailing_escape_is_held_for_the_next_read() {
        let (evs, used) = decode(b"\x1b");
        assert!(evs.is_empty());
        assert_eq!(used, 0);
    }

    #[test]
    fn a_doubled_escape_is_the_escape_key() {
        let k = keys(b"\x1b\x1b");
        assert_eq!(k.len(), 1);
        assert_eq!(k[0].0, "Escape");
        assert!(!k[0].1.alt);
    }

    #[test]
    fn ss3_arrows_are_arrows_not_alt_o() {
        let k = keys(b"\x1bOA\x1bOD");
        assert_eq!(k.len(), 2, "{k:?}");
        assert_eq!(k[0].0, "ArrowUp");
        assert_eq!(k[1].0, "ArrowLeft");
        assert!(!k[0].1.alt);
    }

    #[test]
    fn ss3_function_keys_decode() {
        let k = keys(b"\x1bOP");
        assert_eq!(k.len(), 1);
        assert_eq!(k[0].0, "F1");
    }

    #[test]
    fn csi_still_wins_over_the_alt_reading() {
        let k = keys(b"\x1b[D");
        assert_eq!(k.len(), 1);
        assert_eq!(k[0].0, "ArrowLeft");
        assert!(!k[0].1.alt);
    }

    #[test]
    fn alt_arrows_in_csi_form_keep_their_modifier() {
        let k = keys(b"\x1b[1;3D");
        assert_eq!(k.len(), 1);
        assert_eq!(k[0].0, "ArrowLeft");
        assert!(k[0].1.alt);
    }

    #[test]
    fn a_split_alt_sequence_survives_being_torn() {
        let (a, used) = decode(b"\x1b");
        assert!(a.is_empty() && used == 0);
        let k = keys(b"\x1b\x7f");
        assert_eq!(k[0].0, "Backspace");
        assert!(k[0].1.alt);
    }

    #[test]
    fn kitty_and_legacy_agree_about_option_delete() {
        for src in [&b"\x1b\x7f"[..], &b"\x1b[127;3u"[..]] {
            let k = keys(src);
            assert_eq!(k.len(), 1, "{src:?} -> {k:?}");
            assert_eq!(k[0].0, "Backspace", "{src:?}");
            assert!(k[0].1.alt, "{src:?} lost alt");
        }
    }

    #[test]
    fn f_keys_decode_from_ss3() {
        for (seq, want) in [
            ("\x1bOP", "F1"),
            ("\x1bOQ", "F2"),
            ("\x1bOR", "F3"),
            ("\x1bOS", "F4"),
        ] {
            let e = ev(seq);
            assert_eq!(e.len(), 1, "SS3 {seq:?}");
            assert_eq!(as_key(&e[0]).0, want, "SS3 {seq:?}");
        }
    }

    #[test]
    fn f_keys_decode_from_bare_csi() {
        for (seq, want) in [
            ("\x1b[P", "F1"),
            ("\x1b[Q", "F2"),
            ("\x1b[R", "F3"),
            ("\x1b[S", "F4"),
        ] {
            let e = ev(seq);
            assert_eq!(e.len(), 1, "CSI {seq:?}");
            assert_eq!(as_key(&e[0]).0, want, "CSI {seq:?}");
        }
    }

    #[test]
    fn f_keys_decode_from_vt220_tilde() {
        for (seq, want) in [
            ("\x1b[11~", "F1"),
            ("\x1b[12~", "F2"),
            ("\x1b[13~", "F3"),
            ("\x1b[14~", "F4"),
            ("\x1b[15~", "F5"),
        ] {
            let e = ev(seq);
            assert_eq!(as_key(&e[0]).0, want, "tilde {seq:?}");
        }
    }

    #[test]
    fn modified_f_keys_still_decode() {
        let e = ev("\x1b[1;2Q");
        assert_eq!(as_key(&e[0]).0, "F2");
    }

    #[test]
    fn a_cursor_position_report_is_not_f3() {
        let e = ev("\x1b[24;80R");
        assert!(e.is_empty(), "CPR must not decode as a key: {e:?}");
    }

    #[test]
    fn a_cpr_at_the_origin_is_still_read_as_the_key() {
        let e = ev("\x1b[1;1R");
        assert_eq!(e.len(), 1);
        assert_eq!(as_key(&e[0]).0, "F3");
    }
}

#[wasm_bindgen(js_name = "decodeTermInput")]
pub fn decode_term_input_json(buf: &[u8]) -> String {
    let (events, consumed) = decode(buf);
    let mut out = String::with_capacity(64 + events.len() * 96);
    out.push_str(&format!("{{\"consumed\":{consumed},\"events\":["));
    for (i, e) in events.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        match e {
            Event::Key {
                key,
                code,
                key_code,
                text,
                mods,
                phase,
                ctrl_char,
            } => {
                out.push_str(&format!(
                    "{{\"t\":\"key\",\"key\":{},\"code\":{},\"keyCode\":{},\"text\":{},\
                     \"mods\":{{\"shift\":{},\"alt\":{},\"ctrl\":{},\"meta\":{}}},\
                     \"phase\":\"{}\",\"ctrlChar\":{}}}",
                    json_str(key),
                    json_str(code),
                    key_code,
                    json_str(text),
                    mods.shift,
                    mods.alt,
                    mods.ctrl,
                    mods.meta,
                    match phase {
                        KeyPhase::Press => "press",
                        KeyPhase::Release => "release",
                    },
                    match ctrl_char {
                        Some(c) => json_str(&c.to_string()),
                        None => "null".to_string(),
                    },
                ));
            }
            Event::Mouse { x, y, phase } => {
                out.push_str(&format!(
                    "{{\"t\":\"mouse\",\"x\":{x},\"y\":{y},\"phase\":\"{}\"}}",
                    match phase {
                        MousePhase::Down => "down",
                        MousePhase::Up => "up",
                        MousePhase::Move => "move",
                    },
                ));
            }
            Event::Wheel { x, y, dir } => {
                out.push_str(&format!(
                    "{{\"t\":\"wheel\",\"x\":{x},\"y\":{y},\"dir\":\"{}\"}}",
                    match dir {
                        WheelDir::Up => "up",
                        WheelDir::Down => "down",
                        WheelDir::Left => "left",
                        WheelDir::Right => "right",
                    },
                ));
            }
        }
    }
    out.push_str("]}");
    out
}

fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}
