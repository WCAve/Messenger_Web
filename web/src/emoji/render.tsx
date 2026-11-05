/** Emoji as images for the Fluent and Twemoji styles. (Noto is a font, so plain text already shows it.) */
import { Fragment, type ReactNode, useState } from 'react';
import { usePrefs } from '../prefs';

// One emoji: flags, keycaps, skin tones, ZWJ sequences and subdivision flags count as one.
const EMOJI_RE =
  /(\p{Regional_Indicator}\p{Regional_Indicator}|[#*0-9]️?⃣|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)\p{Emoji_Modifier}?(?:‍(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️?)\p{Emoji_Modifier}?)*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)/u;

/** File name for an emoji: code points in hex, without U+FE0F (how web/scripts/gen-emoji-assets.py names them). */
export function emojiFile(e: string): string {
  return [...e]
    .map((c) => c.codePointAt(0)!.toString(16))
    .filter((h) => h !== 'fe0f')
    .join('-');
}

const EXT: Record<string, string> = { fluent: 'webp', twemoji: 'png' };
const missing = new Set<string>(); // no image for this one in the current set: show it as text

function EmojiImg({ e, set }: { e: string; set: string }) {
  const src = `/emoji/${set}/${emojiFile(e)}.${EXT[set]}`;
  const [failed, setFailed] = useState(() => missing.has(src));
  if (failed) return <>{e}</>;
  return (
    <img
      className="emoji"
      src={src}
      alt={e}
      draggable={false}
      loading="lazy"
      onError={() => {
        missing.add(src);
        setFailed(true);
      }}
    />
  );
}

/** Text with each emoji drawn in the chosen style. */
export function Emojified({ text }: { text: string | null | undefined }): ReactNode {
  const set = usePrefs().emoji;
  if (!text) return text ?? null;
  if (!EXT[set]) return text;
  const parts = text.split(EMOJI_RE); // odd indexes are emoji (one capturing group)
  if (parts.length === 1) return text;
  return (
    <>
      {parts.map((p, i) => (i % 2 ? <EmojiImg key={i} e={p} set={set} /> : p ? <Fragment key={i}>{p}</Fragment> : null))}
    </>
  );
}
