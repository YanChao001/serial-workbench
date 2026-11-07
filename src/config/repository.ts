import config from "../../repository.config.json";
import {
  formatRepositoryLink,
  type RepositoryLinkParameters,
} from "./repository-links.mjs";

export const REPOSITORY_CONFIG = config;

export function repositoryLink(
  kind: keyof typeof config.hosting.links,
  repositoryUrl: string,
  parameters: RepositoryLinkParameters = {},
): string {
  return formatRepositoryLink(
    config.hosting.links[kind],
    repositoryUrl,
    parameters,
  );
}

export function repositoryFileUrl(
  repository: string,
  file: string,
  hosting: {
    defaultBranch: string;
    links: { file: string };
  } = REPOSITORY_CONFIG.hosting,
): string {
  return formatRepositoryLink(hosting.links.file, repository, {
    ref: hosting.defaultBranch,
    path: file,
  });
}
