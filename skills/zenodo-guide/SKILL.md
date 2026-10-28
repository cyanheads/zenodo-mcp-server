---
name: zenodo-guide
description: Find and inspect research artifacts with zenodo_* tools. Use when recovering the dataset or software version cited by a paper, auditing a grant or community's deposits, or checking candidate files across DOI resolution, discovery, version selection, and archive inspection.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use Zenodo for deposited research datasets, archived software releases, and publications, especially when following a paper's artifact citation. The tools inspect existing deposits; they do not publish deposits, retrieve arbitrary repositories, or bulk-harvest the corpus. A DOI with no matching Zenodo record may still resolve elsewhere.

## Identifiers

| Needed identity | Where to obtain it |
|:--|:--|
| A particular release's record ID | A search hit, the resolved record from `zenodo_get_record`, or a version entry from `zenodo_list_versions` |
| A deposit's version series | The concept ID or concept DOI returned with its record or version history |
| A community, funder, award, license, or resource type filter | The matching `zenodo_lookup_vocabulary` entry: use its `filter_value` for its named `filter_param` |
| A top-level file key | A manifest entry from `zenodo_list_files` |
| A metadata continuation | A `zenodo_get_record` continuation: preserve its cursor and accompanying record ID together |

## Gates

1. **Select the release before inspecting its files or producing its citation.** A concept resolves to the latest version. If the task concerns a paper's historical results, inspect the version history and retain the selected version's numeric record ID for subsequent calls. A concept alone does not establish which release the paper used; leave that unresolved when the citation supplies no deciding evidence.
2. **Establish the funding identity before counting outputs.** Compare a funder's country and ROR identity with the requested organization. Scope award lookup to that funder and check the returned award details. Carry the full award filter value forward: a bare grant number searches by number without identifying its funder.
3. **Check coverage before claiming completeness.** Discovery searches latest versions by default; decide whether the task counts deposits or releases. Follow returned pages for the relevant search or manifest and cursors for the relevant metadata field. When discovery's total exceeds its reachable set, narrow the search or report the coverage limit instead of calling the reachable set complete.
4. **Distinguish unavailable inspection from absence.** Check file access and any active filename filter before concluding that a deposit lacks a file. An archive inspection failure means its contents remain uninspected; it does not establish that a member is absent.
5. **Bound conclusions to the content inspected.** Continue a top-level text file using its returned `next_offset`. When a preview is incomplete and no continuation is supplied, use the file's download link and disclose any content still uninspected. Do not describe a preview as a complete file review while `has_more` remains true.

## Core chain

Resolve the cited artifact or discover candidates → select the relevant version → inspect its metadata → locate exact file keys → read the files or ZIP members needed to answer the question. Keep the selected version ID throughout this chain so a concept's changing latest version does not change the artifact being inspected.

## Workflows

**Recover a cited artifact.** Send a supplied DOI to `zenodo_get_record`; use title or topic discovery when the paper provides no usable identifier. Compare the resolved record with the citation and consult `zenodo_list_versions` when release selection needs evidence. Read the selected release's documentation, citation file, or data description before attributing its contents to the paper. Produce a citation for that selected release.

**Audit a grant or community.** Resolve the named community or funder with `zenodo_lookup_vocabulary`; for a grant, resolve its award within the selected funder. Search using the returned filter identities. State the selected community or award, date scope, version policy, and any coverage limit with the resulting inventory. Describe the results as Zenodo deposits matching that scope, rather than all outputs a project has produced elsewhere.

**Assess a candidate dataset or software archive.** Open a search candidate's full record and follow metadata continuations relevant to the decision. List its files; inspect an archive only when the needed documentation or sample is inside it. Read a README, license, schema, or sample as appropriate. Separate claims in the deposit's description from facts established by inspected content, and identify any relevant remainder you could not inspect.

## References

Use [query syntax](references/query-syntax.md) when constructing a Boolean or fielded discovery query.
