import * as vscode from "vscode";
import {exec} from 'child_process';
import * as path from 'path';

interface ICommand {
	match?: string;
	notMatch?: string;
	cmd: string;
	isAsync: boolean;
}

interface IConfig {
	shell: string;
	autoClearConsole: boolean;
	commands: Array<ICommand>;
}

export class RunOnSaveExtension {
	private _outputChannel: vscode.OutputChannel;
	private _context: vscode.ExtensionContext;
	private _config: IConfig;

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
		this._outputChannel = vscode.window.createOutputChannel('Run On Save');
		this.loadConfig();
	}

	private runInTerminal(command) {
		let editor = vscode.window.activeTextEditor;
		let document = editor.document;
		let eol = editor.document.lineCount + 1;
		let position = editor.selection.active;
		var startPos = new vscode.Position(eol, 0);
		var endPos = new vscode.Position(eol, command.length);
		var selStartPos = new vscode.Position(eol - 1, 0);
		var newSelection = new vscode.Selection(selStartPos, endPos);
        editor.edit((edits) => {
            edits.insert(startPos, '\n' + command);
        }).then(() => {
            editor.selection = newSelection;
            vscode.commands.executeCommand('workbench.action.terminal.runSelectedText');
            vscode.commands.executeCommand('undo');
        }, () => {
            vscode.window.showErrorMessage("Unable to run task");
        })
    }

	private runAllInTerminal(commands: ICommand[]): void {
		commands.forEach(command => {
			this.showTerminal();
			this.runInTerminal(command.cmd);
		});
	}

	/** Recursive call to run commands. */
	private _runCommands(commands: Array<ICommand>): void {
		if (commands.length) {
			var cfg = commands.shift();

			this.showOutputMessage(`*** cmd start: ${cfg.cmd}`);

			var child = exec(cfg.cmd, this._execOption);
			child.stdout.on('data', data => this._outputChannel.append(data));
			child.stderr.on('data', data => this._outputChannel.append(data));
			child.on('exit', (e) => {
				// if sync
				if (!cfg.isAsync) {
					this._runCommands(commands);
				}
			});

			// if async, go ahead and run next command
			if (cfg.isAsync) {
				this._runCommands(commands);
			}
		}
		else {
			// NOTE: This technically just marks the end of commands starting.
			// There could still be asyc commands running.
			this.showStatusMessage('Run on Save done.');
		}
	}

	private get _execOption(): { shell: string } {
		if (this.shell) {
			return { shell: this.shell };
		}
	}

	public get isEnabled(): boolean {
		return !!this._context.globalState.get('isEnabled', true);
	}
	public set isEnabled(value: boolean) {
		this._context.globalState.update('isEnabled', value);
		this.showOutputMessage();
	}

	public get shell(): string {
		return this._config.shell;
	}

	public get autoClearConsole(): boolean {
		return !!this._config.autoClearConsole;
	}

	public get commands(): Array<ICommand> {
		return this._config.commands || [];
	}

	public loadConfig(): void {
		this._config = <IConfig><any>vscode.workspace.getConfiguration('saveAndRun');
	}

	/**
	 * Show message in output channel
	 */
	public showOutputMessage(message?: string): void {
		message = message || `Run On Save ${this.isEnabled ? 'enabled' : 'disabled'}.`;
		this._outputChannel.appendLine(message);
	}

	private showTerminal() {
		vscode.commands.executeCommand("workbench.action.terminal.focus");
	}

	/**
	 * Show message in status bar and output channel.
	 * Return a disposable to remove status bar message.
	 */
	public showStatusMessage(message: string): vscode.Disposable {
		this.showOutputMessage(message);
		return vscode.window.setStatusBarMessage(message);
	}

	public runCommands(document: vscode.TextDocument): void {
		if (this.autoClearConsole) {
			this._outputChannel.clear();
		}

		if (!this.isEnabled || this.commands.length === 0) {
			this.showOutputMessage();
			return;
		}

		var match = (pattern: string) => pattern && pattern.length > 0 && new RegExp(pattern).test(document.fileName);

		var commandConfigs = this.commands
			.filter(cfg => {
				var matchPattern = cfg.match || '';
				var negatePattern = cfg.notMatch || '';

				// if no match pattern was provided, or if match pattern succeeds
				var isMatch = matchPattern.length === 0 || match(matchPattern);

				// negation has to be explicitly provided
				var isNegate = negatePattern.length > 0 && match(negatePattern);

				// negation wins over match
				return !isNegate && isMatch;
			});

		if (commandConfigs.length === 0) {
			return;
		}

		this.showStatusMessage('Running on save commands...');

		// build our commands by replacing parameters with values
		var commands: Array<ICommand> = [];
		for (let cfg of commandConfigs) {
			var cmdStr = cfg.cmd;

			var extName = path.extname(document.fileName);

			var root = vscode.workspace.rootPath;
			var relativeFile = "." + document.fileName.replace(root, "");

			cmdStr = cmdStr.replace(/\${relativeFile}/g, relativeFile);
			cmdStr = cmdStr.replace(/\${file}/g, `${document.fileName}`);
			cmdStr = cmdStr.replace(/\${workspaceRoot}/g, `${vscode.workspace.rootPath}`);
			cmdStr = cmdStr.replace(/\${fileBasename}/g, `${path.basename(document.fileName)}`);
			cmdStr = cmdStr.replace(/\${fileDirname}/g, `${path.dirname(document.fileName)}`);
			cmdStr = cmdStr.replace(/\${fileExtname}/g, `${extName}`);
			cmdStr = cmdStr.replace(/\${fileBasenameNoExt}/g, `${path.basename(document.fileName, extName)}`);
			cmdStr = cmdStr.replace(/\${cwd}/g, `${process.cwd()}`);

			// replace environment variables ${env.Name}
			cmdStr = cmdStr.replace(/\${env\.([^}]+)}/g, (sub: string, envName: string) => {
				return process.env[envName];
			});

			commands.push({
				cmd: cmdStr,
				isAsync: !!cfg.isAsync
			});
		}

		//this._runCommands(commands);
		this.runAllInTerminal(commands);
	}
}
