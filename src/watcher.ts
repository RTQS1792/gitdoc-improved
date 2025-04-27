import * as vscode from "vscode";
import config from "./config";
import { ForcePushMode, GitAPI, Repository, RefType } from "./git";
import { DateTime } from "luxon";
import { store } from "./store";
import { reaction } from "mobx";
import * as minimatch from "minimatch";

const REMOTE_NAME = "origin";

// Define consistent emojis for commit types
const COMMIT_EMOJIS = {
  feat: "✨",
  fix: "🐛",
  docs: "📝",
  style: "💄",
  refactor: "♻️",
  perf: "⚡️",
  test: "✅",
  build: "👷",
  ci: "💚",
  chore: "🔧",
  update: "🔄",
  add: "➕",
  remove: "➖",
  move: "🚚",
  rename: "🏷️",
  security: "🔒",
  ui: "🎨",
  init: "🎉",
  config: "🔧",
  wip: "🚧",
  default: "📦"
};

async function pushRepository(
  repository: Repository,
  forcePush: boolean = false
) {
  if (!(await hasRemotes(repository))) return;

  store.isPushing = true;

  try {
    if (config.autoPull === "onPush") {
      await pullRepository(repository);
    }

    const pushArgs: any[] = [REMOTE_NAME, repository.state.HEAD?.name, false];

    if (forcePush) {
      pushArgs.push(ForcePushMode.Force);
    } else if (config.pushMode !== "push") {
      const pushMode =
        config.pushMode === "forcePush"
          ? ForcePushMode.Force
          : ForcePushMode.ForceWithLease;

      pushArgs.push(pushMode);
    }

    await repository.push(...pushArgs);

    store.isPushing = false;
  } catch (error) {
    store.isPushing = false;
    console.error("Push failed:", error);

    if (
      await vscode.window.showWarningMessage(
        "Remote repository contains conflicting changes.",
        "Force Push"
      )
    ) {
      await pushRepository(repository, true);
    }
  }
}

async function pullRepository(repository: Repository) {
  if (!(await hasRemotes(repository))) return;

  store.isPulling = true;

  await repository.pull();

  store.isPulling = false;
}

async function hasRemotes(repository: Repository): Promise<boolean> {
  const refs = await repository.getRefs();
  return refs.some((ref) => ref.type === RefType.RemoteHead);
}

function matches(uri: vscode.Uri) {
  return minimatch(uri.path, config.filePattern, { dot: true });
}

interface CommitMessageParts {
  title: string;
  body: string;
}

// Removed unused function - parseCommitMessage
// This was declared but never used in the code

function determineCommitType(title: string): keyof typeof COMMIT_EMOJIS {
  const lowerTitle = title.toLowerCase();

  // Check for common commit type keywords
  for (const [type] of Object.entries(COMMIT_EMOJIS)) {
    if (lowerTitle.includes(type)) {
      return type as keyof typeof COMMIT_EMOJIS;
    }
  }

  // Check for common action words
  if (lowerTitle.startsWith('update') || lowerTitle.includes('update')) return 'update' as keyof typeof COMMIT_EMOJIS;
  if (lowerTitle.startsWith('add') || lowerTitle.includes('add')) return 'add' as keyof typeof COMMIT_EMOJIS;
  if (lowerTitle.startsWith('remove') || lowerTitle.includes('remove')) return 'remove' as keyof typeof COMMIT_EMOJIS;
  if (lowerTitle.startsWith('fix') || lowerTitle.includes('fix')) return 'fix' as keyof typeof COMMIT_EMOJIS;
  if (lowerTitle.startsWith('improve') || lowerTitle.includes('improve')) return 'refactor' as keyof typeof COMMIT_EMOJIS;
  if (lowerTitle.startsWith('rename') || lowerTitle.includes('rename')) return 'rename' as keyof typeof COMMIT_EMOJIS;
  if (lowerTitle.startsWith('move') || lowerTitle.includes('move')) return 'move' as keyof typeof COMMIT_EMOJIS;

  return 'default' as keyof typeof COMMIT_EMOJIS;
}

async function generateCommitMessage(repository: Repository, changedUris: vscode.Uri[]): Promise<CommitMessageParts | null> {
  try {
    // Limit the number of files to process to avoid token limits
    const maxFiles = config.aiMaxFiles;
    const maxDiffLength = config.aiMaxDiffLength;
    const urisToProcess = changedUris.slice(0, maxFiles);

    const diffs = await Promise.all(
      urisToProcess.map(async (uri) => {
        const filePath = vscode.workspace.asRelativePath(uri);
        const fileDiff = await repository.diffWithHEAD(filePath);

        // Truncate large diffs to avoid exceeding token limits
        const truncatedDiff = fileDiff.length > maxDiffLength
          ? fileDiff.substring(0, maxDiffLength) + '\n... (diff truncated)'
          : fileDiff;

        return `## ${filePath}
---
${truncatedDiff}`;
      }));

    // Add a note if we had to limit the number of files
    const additionalFiles = changedUris.length - urisToProcess.length;
    if (additionalFiles > 0) {
      diffs.push(`\n... and ${additionalFiles} more file(s) changed`);
    }

    console.log('GitDoc AI: Fetching model...');
    const vendorMap: { [key: string]: string } = {
      'gpt-4o': 'copilot',
      'gpt-4-turbo': 'copilot',
      'gpt-3.5-turbo': 'copilot',
      'claude-3.7-sonnet': 'anthropic',
      'claude-3.5-sonnet': 'anthropic',
      'gemini-2.0-flash': 'google',
      'gemini-1.5-pro': 'google',
      'o1': 'copilot',
      'o1-mini': 'copilot'
    };

    const vendor = vendorMap[config.aiModel] || 'copilot';
    const model = await vscode.lm.selectChatModels({ vendor: vendor, family: config.aiModel });

    if (!model || model.length === 0) {
      console.error('GitDoc AI: No model available for family:', config.aiModel);
      vscode.window.showErrorMessage(`GitDoc AI: No model available for family: ${config.aiModel}`);
      return null;
    }

    console.log('GitDoc AI: Model selected:', model[0].id);

    const prompt = `Create a Git commit message with title and body.

Rules:
- Title: Max 50 chars, starts with verb (Update/Fix/Add)
- Body: 2-3 sentences explaining what changed and why
${config.aiUseEmojis && !config.aiUseConsistentEmojis ? '- Start title with relevant emoji' : ''}

Changes:
${diffs.join("\n\n")}

Response format:
TITLE: [your title here]
BODY: [your body here]`;

    console.log('GitDoc AI: Sending request to model...');
    const response = await model[0].sendRequest([{
      role: vscode.LanguageModelChatMessageRole.User,
      name: "User",
      content: prompt
    }]);

    let fullMessage = "";
    for await (const part of response.text) {
      fullMessage += part;
    }

    console.log('GitDoc AI: Raw response:', fullMessage);

    // More flexible parsing to handle different response formats
    let title = '';
    let body = '';

    // Try multiple parsing strategies
    const titleMatch = fullMessage.match(/TITLE:\s*(.+?)(?:\n|$)/i);
    const bodyMatch = fullMessage.match(/BODY:\s*([\s\S]+?)(?:\n\n|$)/i);

    if (titleMatch && bodyMatch) {
      title = titleMatch[1].trim();
      body = bodyMatch[1].trim();
    } else {
      // Fallback parsing - split by double newline
      const parts = fullMessage.split(/\n\n+/).map(part => part.trim());
      if (parts.length >= 2) {
        title = parts[0].replace(/^TITLE:\s*/i, '').trim();
        body = parts[1].replace(/^BODY:\s*/i, '').trim();
      } else {
        // Last resort - use the whole response as title
        title = fullMessage.replace(/^TITLE:\s*/i, '').trim().split('\n')[0];
        body = '';
      }
    }

    // Ensure title is not empty and follows conventions
    if (!title) {
      console.error('GitDoc AI: Empty title extracted');
      return null;
    }

    // Trim title to 50 characters if needed
    if (title.length > 50) {
      title = title.substring(0, 47) + '...';
    }

    console.log('GitDoc AI: Parsed title:', title);
    console.log('GitDoc AI: Parsed body:', body);

    // Add emoji if enabled and not already present
    if (config.aiUseEmojis) {
      // Check if the title already starts with an emoji
      const emojiRegex = /^[\p{Emoji_Presentation}\p{Emoji}\uFE0F]/u;
      if (!emojiRegex.test(title)) {
        const commitType = determineCommitType(title);
        const emoji = COMMIT_EMOJIS[commitType];
        return {
          title: `${emoji} ${title}`,
          body: body
        };
      }
    }

    return { title, body };
  } catch (error) {
    console.error('GitDoc AI: Error generating commit message:', error);
    vscode.window.showErrorMessage(`GitDoc AI: Error - ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function commit(repository: Repository, message?: string) {
  // This function shouldn't ever be called when GitDoc
  // is disabled, but we're checking it just in case.
  if (store.enabled === false) return;

  const changes = [
    ...repository.state.workingTreeChanges,
    ...repository.state.mergeChanges,
    ...repository.state.indexChanges,
  ];

  if (changes.length === 0) return;

  const changedUris = changes
    .filter((change) => matches(change.uri))
    .map((change) => change.uri);

  if (changedUris.length === 0) return;

  if (config.commitValidationLevel !== "none") {
    const diagnostics = vscode.languages
      .getDiagnostics()
      .filter(([uri, diagnostics]) => {
        const isChanged = changedUris.find(
          (changedUri) =>
            changedUri.toString().localeCompare(uri.toString()) === 0
        );

        return isChanged
          ? diagnostics.some(
            (diagnostic) =>
              diagnostic.severity === vscode.DiagnosticSeverity.Error ||
              (config.commitValidationLevel === "warning" &&
                diagnostic.severity === vscode.DiagnosticSeverity.Warning)
          )
          : false;
      });

    if (diagnostics.length > 0) {
      return;
    }
  }

  let currentTime = DateTime.now();

  // Ensure that the commit dates are formatted
  // as UTC, so that other clients can properly
  // re-offset them based on the user's locale.
  const commitDate = currentTime.toUTC().toString();
  process.env.GIT_AUTHOR_DATE = commitDate;
  process.env.GIT_COMMITTER_DATE = commitDate;

  if (config.timeZone) {
    currentTime = currentTime.setZone(config.timeZone);
  }

  let commitMessage = message || currentTime.toFormat(config.commitMessageFormat);

  if (config.aiEnabled) {
    console.log('GitDoc AI: Attempting to generate AI commit message...');
    const aiMessage = await generateCommitMessage(repository, changedUris);

    if (aiMessage) {
      // Combine title and body with proper formatting
      commitMessage = aiMessage.title;
      if (aiMessage.body) {
        commitMessage += `\n\n${aiMessage.body}`;
      }
      console.log('GitDoc AI: Successfully generated commit message');
    } else {
      console.log('GitDoc AI: Failed to generate message, falling back to date/time format');
      vscode.window.showWarningMessage('GitDoc AI: Using fallback date/time format for commit message');
    }
  }

  await repository.commit(commitMessage, { all: true, noVerify: config.noVerify });

  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;

  if (config.autoPush === "onCommit") {
    await pushRepository(repository);
  }

  if (config.autoPull === "onCommit") {
    await pullRepository(repository);
  }
}

// Debounce function remains the same...
function debounce(fn: Function, delay: number) {
  let timeout: NodeJS.Timeout | null = null;

  return (...args: any[]) => {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      fn(...args);
    }, delay);
  };
}

// The rest of the file (commitMap, statusBarItem, etc.) remains the same...
const commitMap = new Map();
function debouncedCommit(repository: Repository) {
  if (!commitMap.has(repository)) {
    commitMap.set(
      repository,
      debounce(() => commit(repository), config.autoCommitDelay)
    );
  }

  return commitMap.get(repository);
}

let statusBarItem: vscode.StatusBarItem | null = null;
export function ensureStatusBarItem() {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left
    );

    statusBarItem.text = "$(mirror)";
    statusBarItem.tooltip = "GitDoc: Auto-commiting files on save";
    statusBarItem.command = "gitdoc.disable";
    statusBarItem.show();
  }

  return statusBarItem;
}

let disposables: vscode.Disposable[] = [];
export function watchForChanges(git: GitAPI): vscode.Disposable {
  const commitAfterDelay = debouncedCommit(git.repositories[0]);
  disposables.push(git.repositories[0].state.onDidChange(commitAfterDelay));

  ensureStatusBarItem();

  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && matches(editor.document.uri)) {
        statusBarItem?.show();
      } else {
        statusBarItem?.hide();
      }
    })
  );

  if (
    vscode.window.activeTextEditor &&
    matches(vscode.window.activeTextEditor.document.uri)
  ) {
    statusBarItem?.show();
  } else {
    statusBarItem?.hide();
  }

  disposables.push({
    dispose: () => {
      statusBarItem?.dispose();
      statusBarItem = null;
    },
  });

  if (config.autoPush === "afterDelay") {
    const interval = setInterval(async () => {
      pushRepository(git.repositories[0]);
    }, config.autoPushDelay);

    disposables.push({
      dispose: () => {
        clearInterval(interval);
      },
    });
  }

  if (config.autoPull === "afterDelay") {
    const interval = setInterval(
      async () => pullRepository(git.repositories[0]),
      config.autoPullDelay
    );

    disposables.push({
      dispose: () => clearInterval(interval),
    });
  }

  const reactionDisposable = reaction(
    () => [store.isPushing, store.isPulling],
    () => {
      const suffix = store.isPushing
        ? " (Pushing...)"
        : store.isPulling
          ? " (Pulling...)"
          : "";
      statusBarItem!.text = `$(mirror)${suffix}`;
    }
  );

  disposables.push({
    dispose: reactionDisposable,
  });

  if (config.pullOnOpen) {
    pullRepository(git.repositories[0]);
  }

  return {
    dispose: () => {
      disposables.forEach((disposable) => disposable.dispose());
      disposables = [];
    },
  };
}