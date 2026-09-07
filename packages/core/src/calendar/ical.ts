/**
 * The slice of RFC 5545 Jarvis actually needs: read a VEVENT, write a VEVENT,
 * and change one without destroying the properties it does not understand.
 *
 * Deliberately not a general iCalendar library. It parses the properties that
 * put an event on a timeline and treats every other line as opaque text to be
 * preserved verbatim — which is why an update keeps attendees, alarms and
 * recurrence rules that this code has no model for.
 */

export interface ParsedEvent {
  uid: string | null;
  summary: string;
  description: string | null;
  location: string | null;
  /** ISO-8601 UTC. */
  startsAt: string;
  /** ISO-8601 UTC, exclusive. */
  endsAt: string;
  allDay: boolean;
  /** Set on an expanded occurrence of a repeating series. */
  recurrenceId: string | null;
  recurring: boolean;
  /** The VCALENDAR wrapper holding exactly this VEVENT. */
  raw: string;
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

/**
 * Undo RFC 5545 line folding: a continuation line starts with one space or tab,
 * and the delimiter plus that one character are removed.
 */
export function unfold(ics: string): string[] {
  const lines: string[] = [];
  for (const line of ics.replace(/\r\n/g, '\n').split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line !== '') {
      lines.push(line);
    }
  }
  return lines;
}

/** Fold to 75 octets, as strict servers require. */
function fold(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts: string[] = [];
  let part = '';
  for (const char of line) {
    const limit = parts.length ? 74 : 75;
    if (part && Buffer.byteLength(part + char) > limit) {
      parts.push(part);
      part = char;
    } else {
      part += char;
    }
  }
  if (part) parts.push(part);
  return parts.join('\r\n ');
}

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match, char: string) =>
    char === 'n' || char === 'N' ? '\n' : char,
  );
}

/** Split a content line, honouring the quoted parameter values that may hold `:`. */
function parseProperty(line: string): Property | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const eq = param.indexOf('=');
    if (eq > 0) {
      params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, '');
    }
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** The UTC offset, in milliseconds, that `zone` had at `instant`. */
function zoneOffsetMs(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  // `hour` comes back as 24 at midnight in some ICU versions; Date.UTC normalises it.
  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  return asUtc - instant;
}

/**
 * A wall-clock time in a named zone, as a UTC instant.
 *
 * Two passes: the first offset is looked up at the naive instant, the second at
 * the corrected one, which is what makes the hour after a DST change land on
 * the right side of the transition. An unknown zone falls back to UTC rather
 * than throwing — a sync must not fail over one exotic TZID.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string,
): string {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  try {
    const corrected = naive - zoneOffsetMs(naive, zone);
    return new Date(naive - zoneOffsetMs(corrected, zone)).toISOString();
  } catch {
    return new Date(naive).toISOString();
  }
}

/** Parse a DATE or DATE-TIME value into an ISO-8601 UTC instant. */
export function parseIcsDate(value: string, params: Record<string, string> = {}): string | null {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  if (date) {
    return new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]))).toISOString();
  }
  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value.trim());
  if (!stamp) return null;
  const [, y, mo, d, h, mi, s, utc] = stamp;
  const parts = [Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s)] as const;
  if (utc || !params.TZID) {
    // No zone at all is a floating time. Reading it as UTC is a choice, not a
    // guess that can be avoided: nothing in the event says which zone it meant.
    return new Date(
      Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]),
    ).toISOString();
  }
  return zonedToUtc(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], params.TZID);
}

/** ISO-8601 durations, restricted to the day/time forms a calendar emits. */
export function parseIcsDuration(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const total =
    (Number(weeks ?? 0) * 7 + Number(days ?? 0)) * 86_400_000 +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1000;
  return sign === '-' ? -total : total;
}

const ICS_HEADER = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jarvis//Calendar//EN'];

/**
 * Every VEVENT in an iCalendar object.
 *
 * A CalDAV `expand` report returns one calendar object per resource holding
 * every occurrence in the window, so this returns a list, not a single event.
 */
export function parseVEvents(ics: string): ParsedEvent[] {
  const lines = unfold(ics);
  const events: ParsedEvent[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.toUpperCase().startsWith('BEGIN:VEVENT')) {
      current = [line];
      continue;
    }
    if (!current) continue;
    current.push(line);
    if (line.toUpperCase().startsWith('END:VEVENT')) {
      const parsed = parseSingle(current);
      if (parsed) events.push(parsed);
      current = null;
    }
  }
  return events;
}

function parseSingle(lines: string[]): ParsedEvent | null {
  const props = new Map<string, Property>();
  for (const line of lines) {
    const property = parseProperty(line);
    // First wins: duplicated properties (X-APPLE variants, per-language
    // SUMMARY) must not silently replace the one already read.
    if (property && !props.has(property.name)) props.set(property.name, property);
  }
  const start = props.get('DTSTART');
  if (!start) return null;
  const startsAt = parseIcsDate(start.value, start.params);
  if (!startsAt) return null;
  const allDay = start.params.VALUE === 'DATE' || /^\d{8}$/.test(start.value.trim());

  const end = props.get('DTEND');
  const duration = props.get('DURATION');
  const endsAt =
    (end ? parseIcsDate(end.value, end.params) : null) ??
    (duration
      ? isoPlus(startsAt, parseIcsDuration(duration.value) ?? 0)
      : isoPlus(startsAt, allDay ? 86_400_000 : 0));

  const recurrenceId = props.get('RECURRENCE-ID');
  const text = (name: string): string | null => {
    const value = props.get(name)?.value;
    const decoded = value === undefined ? null : unescapeText(value).trim();
    return decoded ? decoded : null;
  };
  return {
    uid: text('UID'),
    summary: text('SUMMARY') ?? '(untitled)',
    description: text('DESCRIPTION'),
    location: text('LOCATION'),
    startsAt,
    endsAt,
    allDay,
    recurrenceId: recurrenceId ? recurrenceId.value.trim() : null,
    recurring: Boolean(recurrenceId ?? props.get('RRULE') ?? props.get('RDATE')),
    raw: [...ICS_HEADER, ...lines, 'END:VCALENDAR'].join('\r\n'),
  };
}

function isoPlus(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function icsStamp(iso: string, allDay: boolean): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  if (allDay) return day;
  return `${day}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** Render an instant as the wall clock a named TZID expects -- the inverse of `zonedToUtc`. */
function zonedStamp(iso: string, zone: string): string {
  const instant = new Date(iso).getTime();
  try {
    const wall = new Date(instant + zoneOffsetMs(instant, zone)).toISOString();
    return icsStamp(wall, false).slice(0, -1);
  } catch {
    return icsStamp(iso, false).slice(0, -1);
  }
}

export interface IcsDraft {
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  description: string | null;
  location: string | null;
}

/** The property lines Jarvis owns, in the form a server expects them. */
function timeLines(draft: Pick<IcsDraft, 'startsAt' | 'endsAt' | 'allDay'>): string[] {
  return [
    draft.allDay
      ? `DTSTART;VALUE=DATE:${icsStamp(draft.startsAt, true)}`
      : `DTSTART:${icsStamp(draft.startsAt, false)}`,
    draft.allDay
      ? `DTEND;VALUE=DATE:${icsStamp(draft.endsAt, true)}`
      : `DTEND:${icsStamp(draft.endsAt, false)}`,
  ];
}

/**
 * One date-time property line, in the value type and zone `template` uses.
 *
 * Keeping the original form matters twice over: a rewritten DTSTART must stay
 * on the TZID its RRULE expands against, and a RECURRENCE-ID must match the
 * master's DTSTART value type, as RFC 5545 requires.
 */
function renderTimeLine(
  name: string,
  template: string | null,
  iso: string,
  allDay: boolean,
): string {
  if (allDay) return `${name};VALUE=DATE:${icsStamp(iso, true)}`;
  const property = template ? parseProperty(template) : null;
  const head = template?.split(':', 1)[0];
  const prefix =
    property && head && property.params.VALUE !== 'DATE' ? head.replace(/^[^;]+/, name) : name;
  const value = property?.params.TZID
    ? zonedStamp(iso, property.params.TZID)
    : property?.value.trim().endsWith('Z') === false
      ? icsStamp(iso, false).slice(0, -1)
      : icsStamp(iso, false);
  return `${prefix}:${value}`;
}

function eventTimeLines(
  lines: string[],
  draft: Pick<IcsDraft, 'startsAt' | 'endsAt' | 'allDay'>,
): string[] {
  const original = (name: string) =>
    lines.find((line) => parseProperty(line)?.name === name) ?? null;
  const start = original('DTSTART');
  const end = original('DTEND') ?? start?.replace(/^DTSTART/i, 'DTEND') ?? null;
  return [
    renderTimeLine('DTSTART', start, draft.startsAt, draft.allDay),
    renderTimeLine('DTEND', end, draft.endsAt, draft.allDay),
  ];
}

/**
 * Give an expanded occurrence the RECURRENCE-ID that addresses it.
 *
 * `<C:expand>` strips RRULE and RDATE (RFC 4791 §9.6.5) and need not label the
 * first instance, so an occurrence can come back with no way to name itself.
 * RFC 5545 defines that name exactly: the instance's own start, written in the
 * value type and zone the master's DTSTART uses. Returns null when the master
 * has no DTSTART or the instance has no VEVENT to stamp -- neither is an
 * iCalendar object Jarvis can address.
 */
export function stampRecurrenceId(
  instanceRaw: string,
  masterRaw: string,
  instanceStart: string,
): { raw: string; recurrenceId: string } | null {
  const template = unfold(masterRaw).find((line) => parseProperty(line)?.name === 'DTSTART');
  const start = template ? parseProperty(template) : null;
  if (!template || !start) return null;
  const allDay = start.params.VALUE === 'DATE' || /^\d{8}$/.test(start.value.trim());
  const line = renderTimeLine('RECURRENCE-ID', template, instanceStart, allDay);
  const recurrenceId = parseProperty(line)?.value.trim();
  const lines = unfold(instanceRaw);
  const end = lines.findIndex((entry) => entry.toUpperCase().startsWith('END:VEVENT'));
  if (!recurrenceId || end < 0) return null;
  lines.splice(end, 0, line);
  return { raw: lines.map(fold).join('\r\n'), recurrenceId };
}

function draftLines(draft: IcsDraft): string[] {
  const lines = [`SUMMARY:${escapeText(draft.title)}`, ...timeLines(draft)];
  if (draft.description) lines.push(`DESCRIPTION:${escapeText(draft.description)}`);
  if (draft.location) lines.push(`LOCATION:${escapeText(draft.location)}`);
  return lines;
}

export function buildIcs(uid: string, draft: IcsDraft): string {
  return [
    ...ICS_HEADER,
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(new Date().toISOString(), false)}`,
    ...draftLines(draft),
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .map(fold)
    .join('\r\n');
}

/**
 * Rewrite only the properties Jarvis owns inside an existing object.
 *
 * Rebuilding the event from the draft instead would silently drop the
 * attendees, alarms and recurrence rules that came with it — a data loss the
 * user never asked for when they renamed a meeting.
 */
export function patchIcs(raw: string, draft: IcsDraft): string {
  const owned = new Set(['SUMMARY', 'DTSTART', 'DTEND', 'DURATION', 'DESCRIPTION', 'LOCATION']);
  const output: string[] = [];
  let inEvent = false;
  let written = false;
  for (const line of unfold(raw)) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:VEVENT')) {
      inEvent = true;
      output.push(line);
      continue;
    }
    if (upper.startsWith('END:VEVENT')) {
      if (!written) output.push(...draftLines(draft));
      inEvent = false;
      written = true;
      output.push(line);
      continue;
    }
    if (!inEvent) {
      output.push(line);
      continue;
    }
    const property = parseProperty(line);
    if (property && owned.has(property.name)) {
      // Replace the whole owned set at the first one seen, so the rewritten
      // properties stay together and no stale DURATION survives a new DTEND.
      if (!written) {
        output.push(...draftLines(draft));
        written = true;
      }
      continue;
    }
    output.push(line);
  }
  return output.map(fold).join('\r\n');
}

const OWNED_PROPERTIES = new Set([
  'SUMMARY',
  'DTSTART',
  'DTEND',
  'DURATION',
  'DESCRIPTION',
  'LOCATION',
]);

/** The bare value of a VEVENT block's own RECURRENCE-ID, if it has one. */
function eventRecurrenceId(lines: string[]): string | null {
  for (const line of lines) {
    const property = parseProperty(line);
    if (property?.name === 'RECURRENCE-ID') return property.value.trim();
  }
  return null;
}

/** The exact RECURRENCE-ID content line from a single-VEVENT calendar object, params included. */
export function recurrenceIdLine(raw: string): string | null {
  for (const line of unfold(raw)) {
    if (parseProperty(line)?.name === 'RECURRENCE-ID') return line;
  }
  return null;
}

/** The UID of a VEVENT block, needed to attach a new override to its series. */
function eventUid(lines: string[]): string | null {
  for (const line of lines) {
    const property = parseProperty(line);
    if (property?.name === 'UID') return property.value.trim();
  }
  return null;
}

/** Replace one VEVENT block's owned properties with the draft's, leaving the rest untouched. */
function rewriteEventLines(lines: string[], draft: IcsDraft): string[] {
  const output: string[] = [];
  let written = false;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:VEVENT') || upper.startsWith('END:VEVENT')) {
      output.push(line);
      continue;
    }
    const property = parseProperty(line);
    if (property && OWNED_PROPERTIES.has(property.name)) {
      if (!written) {
        output.push(...draftLines(draft));
        written = true;
      }
      continue;
    }
    output.push(line);
  }
  if (!written) output.splice(output.length - 1, 0, ...draftLines(draft));
  return output;
}

/** Rewrite only fields named by a series patch; every other master line stays byte-for-byte. */
function rewriteEventPatch(lines: string[], patch: Partial<IcsDraft>): string[] {
  const replacements = new Map<string, string[]>();
  if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
    replacements.set('summary', [`SUMMARY:${escapeText(patch.title as string)}`]);
  }
  if (patch.startsAt && patch.endsAt && patch.allDay !== undefined) {
    replacements.set(
      'time',
      eventTimeLines(lines, patch as Required<Pick<IcsDraft, 'startsAt' | 'endsAt' | 'allDay'>>),
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'description')) {
    replacements.set(
      'description',
      patch.description ? [`DESCRIPTION:${escapeText(patch.description)}`] : [],
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'location')) {
    replacements.set('location', patch.location ? [`LOCATION:${escapeText(patch.location)}`] : []);
  }

  const group = (name: string): string | null => {
    if (name === 'SUMMARY') return 'summary';
    if (name === 'DTSTART' || name === 'DTEND' || name === 'DURATION') return 'time';
    if (name === 'DESCRIPTION') return 'description';
    if (name === 'LOCATION') return 'location';
    return null;
  };
  const written = new Set<string>();
  const output: string[] = [];
  for (const line of lines) {
    if (line.toUpperCase().startsWith('END:VEVENT')) {
      for (const [name, replacement] of replacements) {
        if (!written.has(name)) output.push(...replacement);
      }
      output.push(line);
      continue;
    }
    const name = group(parseProperty(line)?.name ?? '');
    if (name && replacements.has(name)) {
      if (!written.has(name)) output.push(...(replacements.get(name) ?? []));
      written.add(name);
      continue;
    }
    output.push(line);
  }
  return output;
}

/**
 * Rewrite one VEVENT inside a multi-object resource -- a recurring master
 * plus any exception overrides -- addressed by its RECURRENCE-ID, or, when
 * `recurrenceId` is null, the master itself (the one VEVENT with none).
 *
 * If no VEVENT matches yet, a new override is appended: an occurrence that
 * has never been edited before has no VEVENT of its own, and creating one --
 * carrying the master's UID and the occurrence's own RECURRENCE-ID -- is what
 * "edit this occurrence" means under RFC 5545. Every other VEVENT in the
 * resource, master or override, passes through untouched.
 */
export function patchIcsEvent(
  raw: string,
  draft: IcsDraft,
  recurrenceId: string | null,
  newRecurrenceIdLine: string | null = null,
  seriesPatch?: Partial<IcsDraft>,
): string {
  const lines = unfold(raw);
  const output: string[] = [];
  let inEvent = false;
  let eventLines: string[] = [];
  let found = false;
  let masterUid: string | null = null;

  const flush = () => {
    const id = eventRecurrenceId(eventLines);
    if (id === null) masterUid ??= eventUid(eventLines);
    const isTarget = recurrenceId === null ? id === null : id === recurrenceId;
    if (isTarget) {
      found = true;
      output.push(
        ...(seriesPatch
          ? rewriteEventPatch(eventLines, seriesPatch)
          : rewriteEventLines(eventLines, draft)),
      );
    } else {
      output.push(...eventLines);
    }
    eventLines = [];
  };

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:VEVENT')) {
      inEvent = true;
      eventLines = [line];
      continue;
    }
    if (inEvent) {
      eventLines.push(line);
      if (upper.startsWith('END:VEVENT')) {
        inEvent = false;
        flush();
      }
      continue;
    }
    output.push(line);
  }

  if (!found) {
    if (recurrenceId === null) throw new Error('the series has no master event to edit');
    if (!newRecurrenceIdLine) {
      throw new Error('missing RECURRENCE-ID for a new occurrence override');
    }
    if (!masterUid) throw new Error('the series has no master event to attach an occurrence to');
    const override = [
      'BEGIN:VEVENT',
      `UID:${masterUid}`,
      `DTSTAMP:${icsStamp(new Date().toISOString(), false)}`,
      newRecurrenceIdLine,
      ...draftLines(draft),
      'END:VEVENT',
    ];
    const end = output.findIndex((line) => line.toUpperCase().startsWith('END:VCALENDAR'));
    output.splice(end < 0 ? output.length : end, 0, ...override);
  }
  return output.map(fold).join('\r\n');
}

/**
 * Exclude one occurrence from a recurring series: an EXDATE matching its
 * RECURRENCE-ID is added to the master, and any override VEVENT already
 * written for that date is dropped with it -- an override for a date the
 * series no longer generates is a dangling reference no server expects.
 */
export function excludeIcsOccurrence(
  raw: string,
  recurrenceId: string,
  exdateLine: string,
): string {
  const lines = unfold(raw);
  const output: string[] = [];
  let inEvent = false;
  let eventLines: string[] = [];

  const flush = () => {
    const id = eventRecurrenceId(eventLines);
    if (id === recurrenceId) {
      eventLines = [];
      return;
    }
    if (id === null) eventLines.splice(eventLines.length - 1, 0, exdateLine);
    output.push(...eventLines);
    eventLines = [];
  };

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:VEVENT')) {
      inEvent = true;
      eventLines = [line];
      continue;
    }
    if (inEvent) {
      eventLines.push(line);
      if (upper.startsWith('END:VEVENT')) {
        inEvent = false;
        flush();
      }
      continue;
    }
    output.push(line);
  }
  return output.map(fold).join('\r\n');
}
