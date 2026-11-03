import { type ReactNode, useEffect, useId, useState } from 'react';
import { hueFor, initials } from '../util';

const PATHS: Record<string, ReactNode> = {
  send: <path d="M3.4 20.4 21 12 3.4 3.6 3.3 10.1 15 12 3.3 13.9z" />,
  attach: (
    <path d="M16.5 6.5v10.6a4.5 4.5 0 0 1-9 0V5.6a3 3 0 0 1 6 0v10.3a1.5 1.5 0 0 1-3 0V6.5H9v9.4a3 3 0 0 0 6 0V5.6a4.5 4.5 0 0 0-9 0v11.5a6 6 0 0 0 12 0V6.5z" />
  ),
  plus: <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />,
  back: <path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z" />,
  close: <path d="M18.3 5.7 16.9 4.3 12 9.2 7.1 4.3 5.7 5.7 10.6 12l-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z" />,
  search: (
    <path d="M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z" />
  ),
  reply: <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" />,
  smile: (
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm3.5-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm-7 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm3.5 6.5c2.3 0 4.3-1.5 5.1-3.5H6.9c.8 2 2.8 3.5 5.1 3.5z" />
  ),
  more: <path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />,
  trash: <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z" />,
  copy: <path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11z" />,
  retry: <path d="M17.7 6.3A8 8 0 1 0 19.7 14h-2.1a6 6 0 1 1-1.4-6.2L13 11h7V4z" />,
  file: <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm4 18H6V4h7v5h5z" />,
  download: <path d="M19 9h-4V3H9v6H5l7 7zM5 18v2h14v-2z" />,
  refresh: <path d="M17.7 6.3A8 8 0 1 0 19.7 14h-2.1a6 6 0 1 1-1.4-6.2L13 11h7V4z" />,
  logout: <path d="M10 17v-3H3v-4h7V7l5 5zm2-15h7a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-7v-2h7V4h-7z" />,
  group: (
    <path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 2 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z" />
  ),
  info: <path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z" />,
  gif: <path d="M11.5 9H13v6h-1.5zM9 9H6c-.6 0-1 .5-1 1v4c0 .5.4 1 1 1h3c.6 0 1-.5 1-1v-2H8.5v1.5h-2v-3H10V10c0-.5-.4-1-1-1zm10 1.5V9h-4.5v6H16v-2h2v-1.5h-2v-1z" />,
  link: <path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z" />,
  camera: (
    <path d="M12 9a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm8-3h-3.2L15 4H9L7.2 6H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-8 12a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z" />
  ),
  check: <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" />,
  pencil: <path d="M3 17.3V21h3.7L17.8 9.9l-3.7-3.7zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7z" />,
  gear: (
    <path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7 7 0 0 0-1.7-1L15 3h-4l-.4 2.9a7 7 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7 7 0 0 0 1.7 1L11 21h4l.4-2.9a7 7 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)" />
  ),
  bell: <path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1z" />,
};

export function Icon({ name, size = 22, title }: { name: keyof typeof PATHS | string; size?: number; title?: string }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} fill="currentColor">
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}

const failedAvatars = new Set<string>(); // URLs that 404'd this session: don't retry on every render

export function Avatar({ name, seed, group, size = 44, src }: { name: string; seed: string; group?: boolean; size?: number; src?: string | null }) {
  const hue = hueFor(seed);
  const [failed, setFailed] = useState(() => !src || failedAvatars.has(src));
  useEffect(() => setFailed(!src || failedAvatars.has(src)), [src]);
  return (
    <span className="avatar" style={{ width: size, height: size, ['--hue' as string]: hue, fontSize: size * 0.38 }} aria-hidden>
      {!failed && src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => {
            failedAvatars.add(src);
            setFailed(true);
          }}
        />
      ) : group ? (
        <Icon name="group" size={size * 0.5} />
      ) : (
        initials(name)
      )}
    </span>
  );
}

/**
 * Delivery state of an outgoing message, drawn like Signal: one outlined circle = sent, two outlined
 * circles = delivered, two filled circles = read. Filled vs outlined stays readable at a glance.
 */
export function StatusMark({ status }: { status: string | null }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  if (status === 'pending')
    return (
      <svg className="status pending" width="16" height="16" viewBox="0 0 16 16" aria-label="Sending">
        <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.2 1.6" />
      </svg>
    );
  if (status === 'failed')
    return (
      <svg className="status failed" width="16" height="16" viewBox="0 0 16 16" aria-label="Not sent">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M8 4v5M8 11.2v.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  const check = (cx: number) => `M${cx - 2.5} 8.1l1.7 1.7 3.3-3.5`;
  const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  if (status !== 'delivered' && status !== 'read') {
    return (
      <svg className="status sent" width="16" height="16" viewBox="0 0 16 16" aria-label="Sent">
        <circle cx="8" cy="8" r="5.6" {...line} />
        <path d={check(8)} {...line} />
      </svg>
    );
  }
  const read = status === 'read';
  const cut = { fill: 'none', stroke: 'black', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return (
    <svg className={`status ${status}`} width="21" height="16" viewBox="0 0 21 16" aria-label={read ? 'Read' : 'Delivered'}>
      <defs>
        {/* the back circle disappears where the front one overlaps it */}
        <mask id={`b${uid}`} maskUnits="userSpaceOnUse" x="0" y="0" width="21" height="16">
          <rect width="21" height="16" fill="white" />
          <circle cx="13.5" cy="8" r="7.2" fill="black" />
          {read && <path d={check(7.5)} {...cut} />}
        </mask>
        {read && (
          <mask id={`f${uid}`} maskUnits="userSpaceOnUse" x="0" y="0" width="21" height="16">
            <rect width="21" height="16" fill="white" />
            <path d={check(13.5)} {...cut} />
          </mask>
        )}
      </defs>
      <g mask={`url(#b${uid})`}>
        {read ? (
          <circle cx="7.5" cy="8" r="6.1" fill="currentColor" />
        ) : (
          <>
            <circle cx="7.5" cy="8" r="5.6" {...line} />
            <path d={check(7.5)} {...line} />
          </>
        )}
      </g>
      {read ? (
        <circle cx="13.5" cy="8" r="6.1" fill="currentColor" mask={`url(#f${uid})`} />
      ) : (
        <>
          <circle cx="13.5" cy="8" r="5.6" {...line} />
          <path d={check(13.5)} {...line} />
        </>
      )}
    </svg>
  );
}
