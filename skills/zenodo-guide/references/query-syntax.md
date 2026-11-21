# Research discovery queries

Use `zenodo_get_record` to resolve a supplied DOI or record URL directly. Build a discovery query when the task is to find candidates or deliberately search an indexed field.

| Intent | Query |
|:--|:--|
| Require both concepts | `climate AND model` |
| Require an exact phrase | `"air quality"` |
| Combine alternatives with a requirement | `(climate OR weather) AND dataset` |
| Match a title phrase | `metadata.title:"air quality"` |
| Match an indexed subject | `metadata.subjects.subject:"climate change"` |
| Find deposits by GitHub repository | `custom_fields.code\:codeRepository:"https://github.com/scikit-learn/scikit-learn"` with `all_versions: true` |

Unjoined words use OR, so `climate model` does not require both. Choose explicit grouping when combining AND and OR. Prefer the tool's structured filters for resource type, access, license, community, funder, award, and dates. Resolve named vocabulary entries before using their filter identities. The GitHub repository field contains a literal colon, escaped above with a backslash.

Check `effectiveQuery` and any notice before interpreting the results. The server may balance incomplete syntax when composing filters. A malformed query without composed filters may instead match as plain text, ignoring its operators and field syntax; a fallback notice means the result does not establish the intended Boolean or fielded search.

To search the DOI field, use one quoted `doi:` clause per DOI, for example `doi:"10.5281/zenodo.4321561" OR doi:"10.5281/zenodo.22705923"`. Compare the returned DOI values, or use `zenodo_get_record` to resolve an exact DOI. Include all versions when looking for a historical release. An unescaped slash inside a word can open a regex, so check any regex notice if you pasted multiple bare DOIs. Escape a slash as `\/` when it is part of a text search.

To find a deposit linked to a paper or other source, pass its DOI or URL as `related_identifier`, optionally with `all_versions: true`. This searches across all relation types. DOI matching covers the input as supplied and common DOI forms. Other URLs match exactly.

Use `published_from` and `published_to` for the depositor-supplied publication date. Use `deposited_from` and `deposited_to` for inclusive UTC record creation dates. The `created` and `updated` timestamps describe the Zenodo record. Public availability can start after record creation, for example under an embargo.
