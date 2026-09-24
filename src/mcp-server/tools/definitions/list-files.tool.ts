/**
 * @fileoverview zenodo_list_files — pages a Zenodo deposit's file manifest (taken
 * from the record GET, which embeds the complete manifest), optionally filtered by
 * key substring, or lists the members of one of its .zip files.
 * @module mcp-server/tools/definitions/list-files
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { parseRecordRef } from '@/services/zenodo/identifiers.js';
import { isPreviewable, isZip } from '@/services/zenodo/text-preview.js';
import type { ZenodoRecord } from '@/services/zenodo/types.js';
import { getZenodoService } from '@/services/zenodo/zenodo-service.js';
import { inline } from '../render.js';
import { blankToUndefined } from '../schema-helpers.js';

/** A window of `items` plus the paging facts every arm reports. */
function pageOf<T>(items: T[], offset: number, limit: number) {
  const slice = items.slice(offset, offset + limit);
  const hasMore = offset + limit < items.length;
  return { slice, matched: items.length, hasMore, nextOffset: offset + limit };
}

export const listFiles = tool('zenodo_list_files', {
  title: 'List Zenodo record files',
  description:
    "Page through a Zenodo deposit's file manifest (key, size, MIME type, MD5, download URL, previewability), optionally filtered by a substring of the file key, or list the members inside one of its .zip files by setting archive_key. Restricted and embargoed files return the access status and embargo date with no entries. Read a small text file or ZIP member with zenodo_read_file.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        'The deposit: a record id (22705923), a Zenodo DOI (10.5281/zenodo.22705923), another DOI registered to a Zenodo record, or a zenodo.org/records or doi.org URL. A concept id lists the latest version’s files.',
      ),
    archive_key: z
      .preprocess(blankToUndefined, z.string().max(1000).optional())
      .describe(
        'Exact file key of a .zip in this record (from the manifest) to list its members instead of the manifest. Omit to list the manifest.',
      ),
    key_contains: z
      .preprocess(blankToUndefined, z.string().max(200).optional())
      .describe(
        'Case-insensitive substring filter on file keys (manifest) or member paths (archive), applied before paging.',
      ),
    offset: z.number().int().min(0).default(0).describe('Entries to skip before this page.'),
    limit: z.number().int().min(1).max(200).default(50).describe('Entries per page (1–200).'),
  }),
  output: z.object({
    recid: z
      .string()
      .describe('Record id whose files are listed (the latest version for a concept id).'),
    kind: z
      .enum(['manifest', 'archive'])
      .describe('manifest: the record’s files; archive: members of the .zip named by archive_key.'),
    access_status: z
      .string()
      .describe('Record access status: open, restricted, embargoed, or metadata-only.'),
    files_access: z
      .string()
      .optional()
      .describe('File access: public or restricted; absent when Zenodo does not report it.'),
    embargo_until: z.string().optional().describe('Embargo end date, when an embargo is active.'),
    files_enabled: z.boolean().describe('False for a metadata-only deposit.'),
    key_contains: z.string().optional().describe('The key filter applied, when set.'),
    offset: z.number().describe('Entries skipped before this page.'),
    limit: z.number().describe('Page size applied.'),
    matched: z.number().describe('Entries matching the filter, before paging.'),
    has_more: z.boolean().describe('True when more matching entries follow this page.'),
    next_offset: z.number().optional().describe('Offset of the next page, when has_more.'),
    file_count: z
      .number()
      .optional()
      .describe(
        'Total files in the record (manifest kind); absent when files are restricted or embargoed.',
      ),
    total_bytes: z
      .number()
      .optional()
      .describe(
        'Total size of the record’s files in bytes (manifest kind); absent when files are restricted or embargoed.',
      ),
    entries: z
      .array(
        z
          .object({
            key: z.string().describe('File key — pass to zenodo_read_file as key.'),
            size: z.number().optional().describe('Size in bytes, when reported.'),
            mimetype: z.string().optional().describe('MIME type, when reported.'),
            md5: z.string().optional().describe('MD5 checksum (hex), when reported.'),
            download_url: z.string().describe('Direct download URL.'),
            previewable: z
              .boolean()
              .describe('True when zenodo_read_file can show this file as text.'),
            listable: z
              .boolean()
              .describe(
                'True for a .zip, whose members zenodo_list_files lists when given this key as archive_key.',
              ),
          })
          .describe('One file in the manifest.'),
      )
      .optional()
      .describe('Manifest files on this page (manifest kind); empty when files are restricted.'),
    archive: z
      .object({
        key: z.string().describe('The .zip file key.'),
        size: z.number().optional().describe('Size of the .zip in bytes, when reported.'),
        listed_members: z.number().describe('File members Zenodo listed for this archive.'),
        upstream_truncated: z
          .boolean()
          .describe(
            'True when Zenodo cut the listing at 1,000 nodes (files plus directories), so members are missing.',
          ),
        directory_count: z.number().describe('Directories Zenodo listed for this archive.'),
      })
      .optional()
      .describe('The archive being listed (archive kind); absent when files are restricted.'),
    members: z
      .array(
        z
          .object({
            path: z
              .string()
              .describe(
                'Member path inside the archive — pass to zenodo_read_file as archive_member.',
              ),
            size: z.number().optional().describe('Uncompressed size in bytes, when reported.'),
            compressed_size: z
              .number()
              .optional()
              .describe('Compressed size in bytes, when reported.'),
            mimetype: z.string().optional().describe('MIME type, when reported.'),
            previewable: z
              .boolean()
              .describe('True when zenodo_read_file can show this member as text.'),
          })
          .describe('One archive member.'),
      )
      .optional()
      .describe('Archive members on this page (archive kind); empty when files are restricted.'),
  }),
  enrichment: {
    truncated: z.boolean().describe('True when more matching entries follow this page.'),
    shown: z.number().describe('Entries returned on this page.'),
    cap: z.number().describe('Page size applied.'),
    totalCount: z.number().describe('Entries matching the filter, before paging.'),
    notice: z
      .string()
      .optional()
      .describe('File access notes, empty-filter guidance, listing caps, or paging guidance.'),
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
      when: 'archive_key is not a key in the record, or Zenodo has no member listing for it',
      recovery: 'Call zenodo_list_files without archive_key to see this record’s file keys.',
    },
    {
      reason: 'not_an_archive',
      code: JsonRpcErrorCode.ValidationError,
      when: 'archive_key is not a .zip',
      recovery:
        'Only .zip files can be listed; read a small text file with zenodo_read_file or fetch this file from its download_url.',
    },
    {
      reason: 'archive_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Zenodo cannot open the .zip named by archive_key: its member listing answered HTTP 500 after one retry, or no complete response arrived in time',
      thrownBy: 'service',
      recovery:
        'Zenodo cannot list every .zip; download the archive from the URL in the error message (its download_url in the manifest) and list it locally, or read the record’s other files with zenodo_read_file.',
    },
    {
      reason: 'record_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Zenodo could not serve this record: HTTP 500 after one retry, HTTP 500 while resolving a non-Zenodo DOI, or no complete response within the time budget (its gateway cuts off near 30 s, which deposits with about 10,000 or more files hit)',
      thrownBy: 'service',
      recovery:
        'Read the deposit’s metadata from zenodo_search_records with query doi:"<its DOI>" (all_versions true); withdrawn legacy records and deposits with more than about 10,000 files fail on the record endpoint, so their file manifest cannot be listed, and if a keyword search also fails, Zenodo is degraded.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "Zenodo answered HTTP 429, or this server's shared Zenodo request budget is spent for the current window",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Wait for the retryAfter seconds in the error data, then call zenodo_list_files again with the same arguments.',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.limit, totalCount: 0 });

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

    const { access, files } = record;
    const archiveKey = input.archive_key;
    const common = {
      recid: record.recid,
      kind: archiveKey ? ('archive' as const) : ('manifest' as const),
      access_status: access.status,
      ...(access.files ? { files_access: access.files } : {}),
      ...(access.embargo_until ? { embargo_until: access.embargo_until } : {}),
      files_enabled: files.enabled,
      ...(input.key_contains ? { key_contains: input.key_contains } : {}),
      offset: input.offset,
      limit: input.limit,
    };
    const needle = input.key_contains?.toLowerCase();

    if (files.enabled && access.files === 'restricted') {
      const until = access.embargo_until ? ` until ${access.embargo_until}` : '';
      ctx.enrich.notice(
        `Files are ${access.status}${until}; only metadata is available. zenodo_get_record shows the access details.`,
      );
      return {
        ...common,
        matched: 0,
        has_more: false,
        ...(archiveKey ? { members: [] } : { entries: [] }),
      };
    }

    const notice: string[] = [];
    const finish = <T>(page: ReturnType<typeof pageOf<T>>, noun: 'files' | 'members') => {
      ctx.enrich({ shown: page.slice.length });
      ctx.enrich.total(page.matched);
      if (needle && page.matched === 0) {
        notice.push(
          `No ${noun} contain "${inline(input.key_contains ?? '')}"; call zenodo_list_files again without key_contains.`,
        );
      } else if (page.matched > 0 && input.offset >= page.matched) {
        notice.push(
          `Offset ${input.offset} is past the last of ${page.matched} ${noun}; call again with a lower offset.`,
        );
      }
      if (page.hasMore) {
        notice.push(
          `Showing ${page.slice.length} of ${page.matched}; call again with offset ${page.nextOffset}.`,
        );
        ctx.enrich.truncated({
          shown: page.slice.length,
          cap: input.limit,
          guidance: notice.join(' '),
        });
      } else if (notice.length) {
        ctx.enrich.notice(notice.join(' '));
      }
      return {
        matched: page.matched,
        has_more: page.hasMore,
        ...(page.hasMore ? { next_offset: page.nextOffset } : {}),
      };
    };

    if (!archiveKey) {
      if (!files.enabled) notice.push('This record has no files (metadata-only deposit).');
      const matching = needle
        ? files.entries.filter((e) => e.key.toLowerCase().includes(needle))
        : files.entries;
      const page = pageOf(matching, input.offset, input.limit);
      const paging = finish(page, 'files');
      return {
        ...common,
        ...paging,
        ...(files.count !== undefined ? { file_count: files.count } : {}),
        ...(files.total_bytes !== undefined ? { total_bytes: files.total_bytes } : {}),
        entries: page.slice.map((e) => ({
          ...e,
          previewable: isPreviewable(e.key, e.mimetype),
          listable: isZip(e.key, e.mimetype),
        })),
      };
    }

    const entry = files.entries.find((e) => e.key === archiveKey);
    if (!entry) {
      throw ctx.fail(
        'file_not_found',
        files.enabled
          ? `Record ${record.recid} has no file with key "${inline(archiveKey)}".`
          : `Record ${record.recid} is a metadata-only deposit with no files.`,
        { ...ctx.recoveryFor('file_not_found') },
      );
    }
    if (!isZip(entry.key, entry.mimetype)) {
      throw ctx.fail(
        'not_an_archive',
        `"${inline(archiveKey)}" is not a .zip file${entry.mimetype ? ` (${entry.mimetype})` : ''}; only ZIP archives can be listed.`,
        { ...ctx.recoveryFor('not_an_archive') },
      );
    }
    const container = await service.getContainer(record.recid, entry.key, ctx);
    if (container.status === 'not_found') {
      throw ctx.fail(
        'file_not_found',
        `Zenodo has no member listing for "${inline(archiveKey)}" in record ${record.recid}.`,
        { ...ctx.recoveryFor('file_not_found') },
      );
    }
    const { listing } = container;
    if (listing.upstream_truncated) {
      notice.push(
        'Zenodo lists at most 1,000 entries of an archive, so some members are missing; download the archive from download_url for the complete list.',
      );
    }
    const matching = needle
      ? listing.members.filter((m) => m.path.toLowerCase().includes(needle))
      : listing.members;
    const page = pageOf(matching, input.offset, input.limit);
    const paging = finish(page, 'members');
    return {
      ...common,
      ...paging,
      archive: {
        key: entry.key,
        ...(entry.size !== undefined ? { size: entry.size } : {}),
        listed_members: listing.members.length,
        upstream_truncated: listing.upstream_truncated,
        directory_count: listing.directory_count,
      },
      members: page.slice.map((m) => ({ ...m, previewable: isPreviewable(m.path, m.mimetype) })),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Zenodo record ${result.recid} — ${result.kind === 'archive' ? 'archive members' : 'files'}`,
      `**Kind:** ${result.kind} | **Access:** ${result.access_status}${result.files_access ? `, files ${result.files_access}` : ''}${result.embargo_until ? `, embargoed until ${result.embargo_until}` : ''} | **Files enabled:** ${result.files_enabled}`,
    ];
    const totals = [
      result.file_count !== undefined ? `**File count:** ${result.file_count}` : undefined,
      result.total_bytes !== undefined ? `**Total bytes:** ${result.total_bytes}` : undefined,
    ].filter(Boolean);
    if (totals.length) lines.push(totals.join(' | '));
    lines.push(
      `**Matched:** ${result.matched}${result.key_contains ? ` (key contains "${inline(result.key_contains)}")` : ''} | **Offset:** ${result.offset} | **Limit:** ${result.limit} | **Has more:** ${result.has_more}${result.next_offset !== undefined ? ` | **Next offset:** ${result.next_offset}` : ''}`,
    );

    const a = result.archive;
    if (a) {
      lines.push(
        `**Archive:** ${inline(a.key)} (${a.size ?? '?'} bytes) — ${a.listed_members} members and ${a.directory_count} directories listed; upstream truncated: ${a.upstream_truncated}`,
      );
    }
    for (const e of result.entries ?? []) {
      lines.push(
        `- ${inline(e.key)} — ${e.size ?? '?'} bytes${e.mimetype ? `, ${e.mimetype}` : ''}${e.md5 ? `, md5 ${e.md5}` : ''}; previewable: ${e.previewable}; listable: ${e.listable} — ${e.download_url}`,
      );
    }
    for (const m of result.members ?? []) {
      lines.push(
        `- ${inline(m.path)} — ${m.size ?? '?'} bytes (compressed ${m.compressed_size ?? '?'})${m.mimetype ? `, ${m.mimetype}` : ''}; previewable: ${m.previewable}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
