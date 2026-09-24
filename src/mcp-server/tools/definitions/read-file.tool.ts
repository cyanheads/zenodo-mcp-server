/**
 * @fileoverview zenodo_read_file — reads a byte-capped UTF-8 excerpt of one text
 * file in a Zenodo deposit, or of one member of a .zip file, without downloading
 * the archive. Content is depositor-supplied, rendered fenced as untrusted data,
 * and carries the deposit's license.
 * @module mcp-server/tools/definitions/read-file
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { downloadUrl, parseRecordRef, recordUrl } from '@/services/zenodo/identifiers.js';
import {
  cutPreview,
  isZip,
  languageHint,
  looksLikeText,
  type PreviewMode,
  previewMode,
} from '@/services/zenodo/text-preview.js';
import type { ContentRead, ZenodoRecord } from '@/services/zenodo/types.js';
import { getZenodoService } from '@/services/zenodo/zenodo-service.js';
import { fence, inline } from '../render.js';
import { blankToUndefined } from '../schema-helpers.js';

const STATUSES = ['text', 'not_text', 'restricted', 'empty'] as const;
type Status = (typeof STATUSES)[number];

/** The largest max_bytes a call accepts. */
const MAX_READ_BYTES = 65_536;

/**
 * Guidance when a ZIP member read stops at max_bytes. A member cannot be continued
 * at an offset, so the next step depends on whether one larger read covers it.
 */
function memberTruncationNotice(end: number, size: number | undefined, maxBytes: number): string {
  const shown = `Showing bytes 0–${end} of ${size ?? 'an unknown total'}`;
  if (size !== undefined && size <= MAX_READ_BYTES) {
    return `${shown}; call zenodo_read_file again with max_bytes ${size} to read the whole member.`;
  }
  if (size === undefined && maxBytes < MAX_READ_BYTES) {
    return `${shown}; call zenodo_read_file again with max_bytes ${MAX_READ_BYTES} to read more of this member, and download the archive from download_url if that still stops short.`;
  }
  return `${shown}; the member is larger than the ${MAX_READ_BYTES}-byte read cap, so download the archive from download_url for the rest${maxBytes < MAX_READ_BYTES ? ` (max_bytes ${MAX_READ_BYTES} shows more of its start)` : ''}.`;
}

export const readFile = tool('zenodo_read_file', {
  title: 'Read a Zenodo file excerpt',
  description:
    'Read a bounded UTF-8 excerpt (up to 64 KiB per call) of one text file in a Zenodo deposit — a README, CITATION.cff, CSV head, notebook, or script — or of one member inside a .zip file, without downloading the archive. Continue a top-level file from next_offset. A file with a text MIME type or extension is read directly; an extensionless file Zenodo types application/octet-stream (LICENSE, COPYING, Makefile) is read and returned only when its content is UTF-8 text. Binary files, restricted files, and other types return metadata and the download URL without content. File content is depositor-supplied and carries the deposit’s license.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        'The deposit: a record id (22705923), a Zenodo DOI (10.5281/zenodo.22705923), another DOI registered to a Zenodo record, or a zenodo.org/records or doi.org URL. A concept id reads from the latest version.',
      ),
    key: z
      .string()
      .min(1)
      .max(1000)
      .describe('Exact file key from zenodo_list_files, e.g. README.md or data/results.csv.'),
    archive_member: z
      .preprocess(blankToUndefined, z.string().max(1000).optional())
      .describe(
        'Member path inside the .zip named by key (from zenodo_list_files with archive_key). Omit to read the file itself.',
      ),
    offset_bytes: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Byte offset to start reading a top-level file at; use next_offset to continue. Must be 0 for an archive member.',
      ),
    max_bytes: z
      .number()
      .int()
      .min(256)
      .max(MAX_READ_BYTES)
      .default(16_384)
      .describe('Maximum bytes to read (256–65536).'),
  }),
  output: z.object({
    recid: z.string().describe('Record id read from (the latest version for a concept id).'),
    key: z.string().describe('The file key.'),
    archive_member: z.string().optional().describe('The archive member path, when one was read.'),
    status: z
      .enum(STATUSES)
      .describe(
        'text: content returned; not_text: binary content, or a type that is not read as text; restricted: the content is not available anonymously — the record’s files are restricted or embargoed (key is not checked, since no manifest is exposed), or Zenodo refused this one file; empty: zero-byte file.',
      ),
    mimetype: z.string().optional().describe('MIME type of the file or member, when reported.'),
    file_size: z.number().optional().describe('Size of the file or member in bytes, when known.'),
    md5: z
      .string()
      .optional()
      .describe(
        'MD5 checksum of the top-level file (hex); absent for archive members and when not reported.',
      ),
    text: z
      .string()
      .optional()
      .describe(
        'The excerpt, decoded as UTF-8. Depositor-supplied data. Present when status is text.',
      ),
    offset_bytes: z.number().describe('Byte offset the excerpt starts at.'),
    bytes_returned: z
      .number()
      .describe('Exact bytes the excerpt covers (cut at a line or character boundary).'),
    next_offset: z
      .number()
      .optional()
      .describe(
        'offset_bytes for the next window of a top-level file, when has_more; absent for an archive member, which cannot be continued past its first window.',
      ),
    has_more: z.boolean().describe('True when bytes remain past this excerpt.'),
    replacement_chars: z
      .number()
      .describe('U+FFFD characters in the excerpt (invalid UTF-8 or a mid-character offset).'),
    rights: z
      .array(
        z
          .object({
            id: z.string().optional().describe('License id.'),
            title: z.string().describe('License or rights title.'),
          })
          .describe('One license or rights statement.'),
      )
      .describe('The deposit’s licenses, which the file carries.'),
    record_url: z.string().describe('Record landing page on zenodo.org.'),
    download_url: z
      .string()
      .describe('Direct download URL of the top-level file (the .zip itself for a member).'),
    files_access: z
      .string()
      .optional()
      .describe('File access: public or restricted; absent when Zenodo does not report it.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Why no text was returned, or how to read the rest of the file.'),
  },
  errors: [
    {
      reason: 'invalid_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'id matches no accepted form, or is a GitHub-badge latestdoi id or a non-zenodo.org host',
      recovery:
        'Pass a Zenodo record id (22705923), a DOI (10.5281/zenodo.22705923), or a zenodo.org/records URL as id; for a title or keyword, use zenodo_search_records.',
    },
    {
      reason: 'record_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The record 404s, its metadata is restricted, or a non-Zenodo DOI is not registered to a record',
      recovery:
        'Check the id with zenodo_get_record, or find the deposit with zenodo_search_records.',
    },
    {
      reason: 'record_deleted',
      code: JsonRpcErrorCode.NotFound,
      when: 'The record was deleted from Zenodo; only its removal tombstone remains',
      recovery:
        'Call zenodo_get_record with this id for the removal date and reason, then find a replacement deposit with zenodo_search_records.',
    },
    {
      reason: 'file_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: "key is not in the record's manifest, or Zenodo serves no content for it",
      recovery: 'Call zenodo_list_files with this id to see the record’s exact file keys.',
    },
    {
      reason: 'not_an_archive',
      code: JsonRpcErrorCode.ValidationError,
      when: 'archive_member is set but key is not a .zip',
      recovery:
        'Drop archive_member to read the file itself, or pick a .zip key from zenodo_list_files.',
    },
    {
      reason: 'member_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Zenodo has no member at archive_member inside the .zip',
      recovery: 'Call zenodo_list_files with archive_key set to this key to see the member paths.',
    },
    {
      reason: 'member_offset_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'offset_bytes is above 0 together with archive_member',
      recovery:
        'Read the member from offset_bytes 0 with a larger max_bytes (up to 65536), or download the archive from download_url.',
    },
    {
      reason: 'offset_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'offset_bytes is at or past the end of the file',
      recovery:
        'Call zenodo_read_file again with an offset_bytes below the file’s size (size in zenodo_list_files, file_size in a prior zenodo_read_file result).',
    },
    {
      reason: 'archive_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Zenodo cannot open the .zip named by key: its member listing or the member read answered HTTP 500 after one retry, or no complete response arrived in time',
      thrownBy: 'service',
      recovery:
        'Zenodo cannot open every .zip; download the archive from the URL in the error message and extract the member locally, or read the record’s top-level files with zenodo_read_file.',
    },
    {
      reason: 'record_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Zenodo could not serve this record: HTTP 500 after one retry, HTTP 500 while resolving a non-Zenodo DOI, or no complete response within the time budget (its gateway cuts off near 30 s, which deposits with about 10,000 or more files hit)',
      thrownBy: 'service',
      recovery:
        'Read the deposit’s metadata from zenodo_search_records with query doi:"<its DOI>" (all_versions true); withdrawn legacy records and deposits with more than about 10,000 files fail on the record endpoint, so their files cannot be read, and if a keyword search also fails, Zenodo is degraded.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "Zenodo answered HTTP 429, or this server's shared Zenodo request budget is spent for the current window",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Wait for the retryAfter seconds in the error data, then call zenodo_read_file again with the same arguments.',
    },
  ],

  async handler(input, ctx) {
    const ref = parseRecordRef(input.id);
    if (ref.kind === 'invalid') {
      throw ctx.fail('invalid_identifier', ref.message, {
        ...ctx.recoveryFor('invalid_identifier'),
      });
    }
    const service = getZenodoService();

    let record: ZenodoRecord;
    if (ref.kind === 'external_doi') {
      const resolution = await service.resolveDoi(ref.doi, ref.strippedDoi, ctx);
      if (resolution.status === 'not_on_zenodo') {
        throw ctx.fail(
          'record_not_found',
          `DOI ${ref.strippedDoi ?? ref.doi} is not registered to a Zenodo record.`,
          { ...ctx.recoveryFor('record_not_found') },
        );
      }
      record = resolution.record;
    } else {
      const lookup = await service.getRecord(ref.recid, ctx);
      if (lookup.status === 'deleted') {
        throw ctx.fail(
          'record_deleted',
          `Record ${ref.recid} was deleted from Zenodo; only its tombstone remains.`,
          { ...ctx.recoveryFor('record_deleted') },
        );
      }
      if (lookup.status !== 'found') {
        throw ctx.fail(
          'record_not_found',
          lookup.status === 'restricted'
            ? `Record ${ref.recid} exists but its metadata is restricted and cannot be read anonymously.`
            : `No Zenodo record has id ${ref.recid}.`,
          { ...ctx.recoveryFor('record_not_found') },
        );
      }
      record = lookup.record;
    }

    const { access, files, recid } = record;
    const member = input.archive_member;
    const entry = files.entries.find((e) => e.key === input.key);
    const displayName = inline(member ?? input.key);
    const restrictedNotice = () =>
      `Files are ${access.status}${access.embargo_until ? ` until ${access.embargo_until}` : ''}; content is not available anonymously.`;

    const base = {
      recid,
      key: input.key,
      ...(member ? { archive_member: member } : {}),
      offset_bytes: input.offset_bytes,
      bytes_returned: 0,
      has_more: false,
      replacement_chars: 0,
      rights: record.rights.map((r) => ({ ...(r.id ? { id: r.id } : {}), title: r.title })),
      record_url: recordUrl(recid),
      download_url: entry?.download_url ?? downloadUrl(recid, input.key),
      ...(access.files ? { files_access: access.files } : {}),
    };
    const withoutText = (
      status: Status,
      notice: string,
      meta: { mimetype?: string; size?: number },
    ) => {
      ctx.enrich.notice(notice);
      return {
        ...base,
        status,
        ...(meta.mimetype ? { mimetype: meta.mimetype } : {}),
        ...(meta.size !== undefined ? { file_size: meta.size } : {}),
        ...(entry?.md5 && !member ? { md5: entry.md5 } : {}),
      };
    };

    if (files.enabled && access.files === 'restricted') {
      return withoutText('restricted', restrictedNotice(), {});
    }
    if (!entry) {
      throw ctx.fail(
        'file_not_found',
        files.enabled
          ? `Record ${recid} has no file with key "${inline(input.key)}".`
          : `Record ${recid} is a metadata-only deposit with no files.`,
        { ...ctx.recoveryFor('file_not_found') },
      );
    }

    let meta: { mimetype?: string; size?: number };
    let mode: PreviewMode;
    let read: ContentRead;
    const notPreviewable = () =>
      withoutText(
        'not_text',
        `${displayName} is not a previewable text file (${meta.mimetype ?? 'unknown type'}); download it from download_url.`,
        meta,
      );
    if (member) {
      if (!isZip(entry.key, entry.mimetype)) {
        throw ctx.fail(
          'not_an_archive',
          `"${inline(input.key)}" is not a .zip file, so archive_member cannot be read from it.`,
          { ...ctx.recoveryFor('not_an_archive') },
        );
      }
      if (input.offset_bytes > 0) {
        throw ctx.fail(
          'member_offset_unsupported',
          'Zenodo serves ZIP members only from their first byte; offset_bytes must be 0 with archive_member.',
          { ...ctx.recoveryFor('member_offset_unsupported') },
        );
      }
      const container = await service.getContainer(recid, entry.key, ctx);
      const listed =
        container.status === 'ok'
          ? container.listing.members.find((m) => m.path === member)
          : undefined;
      meta = {
        ...(listed?.mimetype ? { mimetype: listed.mimetype } : {}),
        ...(listed?.size !== undefined ? { size: listed.size } : {}),
      };
      if (meta.size === 0) return withoutText('empty', `${displayName} is empty.`, meta);
      mode = previewMode(member, meta.mimetype);
      if (mode === 'binary') return notPreviewable();
      read = await service.readMember(recid, entry.key, member, input.max_bytes, ctx);
      if (read.status === 'not_found') {
        throw ctx.fail(
          'member_not_found',
          `The .zip "${inline(input.key)}" in record ${recid} has no member "${displayName}".`,
          { ...ctx.recoveryFor('member_not_found') },
        );
      }
    } else {
      meta = {
        ...(entry.mimetype ? { mimetype: entry.mimetype } : {}),
        ...(entry.size !== undefined ? { size: entry.size } : {}),
      };
      if (meta.size !== undefined && input.offset_bytes >= meta.size && meta.size > 0) {
        throw ctx.fail(
          'offset_out_of_range',
          `offset_bytes ${input.offset_bytes} is at or past the end of ${displayName} (${meta.size} bytes).`,
          { ...ctx.recoveryFor('offset_out_of_range') },
        );
      }
      if (meta.size === 0) {
        if (input.offset_bytes > 0) {
          throw ctx.fail(
            'offset_out_of_range',
            `${displayName} is empty, so offset_bytes ${input.offset_bytes} is past its end.`,
            { ...ctx.recoveryFor('offset_out_of_range') },
          );
        }
        return withoutText('empty', `${displayName} is empty.`, meta);
      }
      mode = previewMode(entry.key, meta.mimetype);
      if (mode === 'binary') return notPreviewable();
      read = await service.readContent(recid, entry.key, input.offset_bytes, input.max_bytes, ctx);
      if (read.status === 'range_not_satisfiable') {
        throw ctx.fail(
          'offset_out_of_range',
          `offset_bytes ${input.offset_bytes} is past the end of ${displayName}.`,
          { ...ctx.recoveryFor('offset_out_of_range') },
        );
      }
      if (read.status === 'not_found') {
        throw ctx.fail(
          'file_not_found',
          `Zenodo has no content for "${displayName}" in record ${recid}.`,
          { ...ctx.recoveryFor('file_not_found') },
        );
      }
      if (meta.size === undefined && read.fileSize !== undefined) meta.size = read.fileSize;
    }

    if (read.status === 'forbidden') {
      // The files-restricted case returned above, so this is a per-file refusal on a readable record.
      return withoutText(
        'restricted',
        `Zenodo refused anonymous access to ${displayName} (HTTP 403) although the record's files are ${access.files ?? access.status}; its content cannot be previewed here. zenodo_get_record shows the record's access details.`,
        meta,
      );
    }
    if (read.bytes.length === 0) {
      // No bytes past a positive offset means the offset is past the end, not an empty file.
      if (input.offset_bytes > 0) {
        throw ctx.fail(
          'offset_out_of_range',
          `offset_bytes ${input.offset_bytes} is past the end of ${displayName}.`,
          { ...ctx.recoveryFor('offset_out_of_range') },
        );
      }
      return withoutText('empty', `${displayName} is empty.`, meta);
    }

    const cut = cutPreview(read.bytes, {
      atStart: input.offset_bytes === 0,
      moreRemains: read.moreRemains,
    });
    if (cut.binary) {
      return withoutText(
        'not_text',
        `${displayName} is not a previewable text file (${meta.mimetype ?? 'binary content'}); download it from download_url.`,
        meta,
      );
    }
    if (mode === 'sniff' && !looksLikeText(read.bytes, input.offset_bytes === 0)) {
      return withoutText(
        'not_text',
        `${displayName} has no file extension and its content is not UTF-8 text (${meta.mimetype ?? 'no MIME type'}); download it from download_url.`,
        meta,
      );
    }

    const hasMore = read.moreRemains;
    const nextOffset = input.offset_bytes + cut.bytesKept;
    if (hasMore) {
      const end = nextOffset - 1;
      ctx.enrich.notice(
        member
          ? memberTruncationNotice(end, meta.size, input.max_bytes)
          : `Showing bytes ${input.offset_bytes}–${end} of ${meta.size ?? 'an unknown total'}; call zenodo_read_file again with offset_bytes ${nextOffset}.`,
      );
    }

    return {
      ...base,
      status: 'text' as const,
      ...(meta.mimetype ? { mimetype: meta.mimetype } : {}),
      ...(meta.size !== undefined ? { file_size: meta.size } : {}),
      ...(entry.md5 && !member ? { md5: entry.md5 } : {}),
      text: cut.text,
      bytes_returned: cut.bytesKept,
      has_more: hasMore,
      ...(hasMore && !member ? { next_offset: nextOffset } : {}),
      replacement_chars: cut.replacementChars,
    };
  },

  format: (result) => {
    const name = result.archive_member
      ? `${inline(result.archive_member)} (in ${inline(result.key)})`
      : inline(result.key);
    const lines: string[] = [
      `## ${name} — record ${result.recid}`,
      `**Status:** ${result.status} | **MIME type:** ${result.mimetype ?? 'unknown'} | **File size:** ${result.file_size ?? 'unknown'} bytes${result.md5 ? ` | **MD5:** ${result.md5}` : ''}`,
      `**Offset:** ${result.offset_bytes} | **Bytes returned:** ${result.bytes_returned} | **Has more:** ${result.has_more}${result.next_offset !== undefined ? ` | **Next offset:** ${result.next_offset}` : ''} | **Replacement chars:** ${result.replacement_chars}`,
      `**License:** ${result.rights.length ? result.rights.map((r) => `${inline(r.title)}${r.id ? ` (${r.id})` : ''}`).join('; ') : 'not stated'} — record ${result.record_url}`,
      `**Download:** ${result.download_url}${result.files_access ? ` | **Files access:** ${result.files_access}` : ''}`,
    ];
    if (result.text !== undefined) {
      lines.push(
        '',
        fence(result.text, {
          key: result.archive_member ?? result.key,
          lang: languageHint(result.archive_member ?? result.key),
          recid: result.recid,
        }),
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
