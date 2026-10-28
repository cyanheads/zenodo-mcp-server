# Research discovery queries

Use `zenodo_get_record` to resolve a supplied DOI or record URL directly. Build a discovery query when the task is to find candidates or deliberately search an indexed field.

| Intent | Query |
|:--|:--|
| Require both concepts | `climate AND model` |
| Require an exact phrase | `"air quality"` |
| Combine alternatives with a requirement | `(climate OR weather) AND dataset` |
| Match a title phrase | `metadata.title:"air quality"` |
| Match an indexed subject | `metadata.subjects.subject:"climate change"` |

Unjoined words use OR, so `climate model` does not require both. Choose explicit grouping when combining AND and OR. Prefer the tool's structured filters for resource type, access, license, community, funder, award, and dates; resolve named vocabulary entries before using their filter identities.

Check `effectiveQuery` and any notice before interpreting the results. The server may balance incomplete syntax when composing filters. A malformed query without composed filters may instead match as plain text, ignoring its operators and field syntax; a fallback notice means the result does not establish the intended Boolean or fielded search.

For deliberate DOI-field discovery or a tool's recovery route, quote the DOI as `doi:"<actual DOI>"` and include all versions when searching for a historical release. Replace the placeholder with the supplied DOI. This is distinct from sending a bare DOI as discovery terms.
