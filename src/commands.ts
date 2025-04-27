import * as vscode from "vscode";
import { EXTENSION_NAME } from "./constants";
import { getGitApi } from "./git";
import { updateContext } from "./utils";
import { commit } from "./watcher";
import config from "./config";

interface GitTimelineItem {
  message: string;
  ref: string;
  previousRef: string;
}

export function registerCommands(context: vscode.ExtensionContext) {
  function registerCommand(name: string, callback: (...args: any[]) => any) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`${EXTENSION_NAME}.${name}`, callback)
    );
  }

  registerCommand("enable", updateContext.bind(null, true));
  registerCommand("disable", updateContext.bind(null, false));

  registerCommand("restoreVersion", async (item: GitTimelineItem) => {
    if (!vscode.window.activeTextEditor) {
      return;
    }

    const path = vscode.workspace.asRelativePath(
      vscode.window.activeTextEditor.document.uri.path
    );

    const git = await getGitApi();

    // @ts-ignore
    await git?.repositories[0].repository.repository.checkout(item.ref, [
      path,
    ]);

    // TODO: Look into why the checkout
    // doesn't trigger the watcher.
    commit(git?.repositories[0]!);
  });

  registerCommand("squashVersions", async (item: GitTimelineItem) => {
    const message = await vscode.window.showInputBox({
      prompt: "Enter the name to give to the new squashed version",
      value: item.message,
    });

    if (message) {
      const git = await getGitApi();
      // @ts-ignore
      await git?.repositories[0].repository.reset(`${item.ref}~1`);
      await commit(git?.repositories[0]!, message);
    }
  });

  registerCommand("undoVersion", async (item: GitTimelineItem) => {
    const git = await getGitApi();

    // @ts-ignore
    await git?.repositories[0].repository.repository.run([
      "revert",
      "-n", // Tell Git not to create a commit, so that we can make one with the right message format
      item.ref,
    ]);

    await commit(git?.repositories[0]!);
  });

  registerCommand("commit", async () => {
    const git = await getGitApi();
    if (git && git.repositories.length > 0) {
      await commit(git.repositories[0]);
    }
  });

  // New debug command for AI
  registerCommand("debugAI", async () => {
    const output = vscode.window.createOutputChannel("GitDoc AI Debug");
    output.show();

    output.appendLine("GitDoc AI Debug Information");
    output.appendLine("==========================");
    output.appendLine(`AI Enabled: ${config.aiEnabled}`);
    output.appendLine(`AI Model: ${config.aiModel}`);
    output.appendLine(`Use Emojis: ${config.aiUseEmojis}`);
    output.appendLine(`Use Consistent Emojis: ${config.aiUseConsistentEmojis}`);
    output.appendLine(`Custom Instructions: ${config.aiCustomInstructions ? 'Yes' : 'No'}`);

    output.appendLine("\nTesting AI Model Availability...");
    try {
      const model = await vscode.lm.selectChatModels({ family: config.aiModel });
      if (!model || model.length === 0) {
        output.appendLine(`❌ No model available for family: ${config.aiModel}`);
        output.appendLine("Available model families: " + (await vscode.lm.selectChatModels()).map(m => m.family).join(", "));
      } else {
        output.appendLine(`✅ Model available: ${model[0].id}`);
        output.appendLine(`Model vendor: ${model[0].vendor}`);
        output.appendLine(`Model version: ${model[0].version}`);
      }
    } catch (error) {
      output.appendLine(`❌ Error testing model: ${error instanceof Error ? error.message : String(error)}`);
    }

    output.appendLine("\nTesting Copilot Extension...");
    const copilotExt = vscode.extensions.getExtension("GitHub.copilot");
    if (!copilotExt) {
      output.appendLine("❌ GitHub Copilot extension not found");
    } else {
      output.appendLine(`✅ GitHub Copilot extension found - Active: ${copilotExt.isActive}`);
    }

    output.appendLine("\nDiagnostics complete.");
  });
}