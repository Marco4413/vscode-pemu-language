
const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const PACKAGE = require("./package.json");

const EXTENSION_NAME = PACKAGE.name;
const EXTENSION_DISPLAY_NAME = PACKAGE.displayName;
const EXTENSION_INVALID_JAVA_PATH = "Java couldn't be found, please set its path in the Extension's Settings.";
const EXTENSION_INVALID_JAR_PATH  = "PEMU Jar path isn't valid, please set it in the Extension's Settings.";
const EXTENSION_NO_FILE_OPEN      = "Please open the file you want to perform the command on.";
const EXTENSION_WORD_SIZE_PICK    = "Please pick the Processor's Word Size.";
const EXTENSION_UNSUPPORTED_URI_SCHEME = "File's URI can only be of type \"file\".";

const PEMU_LANGUAGE_ID = "pemu";
const PEMU_WORD_SIZES = [ "8", "16", "24" ];
const PEMU_UNKNOWN_FILE = "Unknown";
class PEMUError {

    /**
     * @param {String} fileName
     * @param {String} errorName
     * @param {String} errorDescription
     * @param {Number} errorLine
     * @param {Number} errorChar
     */
    constructor(fileName, errorName, errorDescription, errorLine, errorChar) {
        this.fileName = fileName;
        this.errorName = errorName;
        this.errorDescription = errorDescription;
        this.errorLine = errorLine;
        this.errorChar = errorChar;
    }

    /**
     * @param {String} str
     * @returns {PEMUError?}
     */
    static createFromString(str) {
        const matches = str.match(/'(.+)': (.+ Error) \((.+):(.+)\): (.+)/);
        if (matches === null) return null;
        return new PEMUError(
            matches[1], matches[2], matches[5],
            Number.parseInt(matches[3]), Number.parseInt(matches[4])
        );
    }

    /**
     * @returns {Boolean}
     */
    isFileKnown() {
        return this.fileName !== PEMU_UNKNOWN_FILE;
    }

    /**
     * @returns {String?}
     */
    getFileName() {
        return this.isFileKnown() ? this.fileName : null;
    }

    /**
     * @returns {Boolean}
     */
    isPositionKnown() {
        return this.errorLine >= 1 && this.errorChar >= 1;
    }

    /**
     * @returns {vscode.Position?}
     */
    getPosition() {
        if (this.isPositionKnown())
            return new vscode.Position(this.errorLine - 1, this.errorChar - 1);
        return null;
    }

    /**
     * @returns {String}
     */
    toString() {
        return "PEMU Compilation Error ->"
             + "\nFile: \t" + this.fileName
             + "\nName: \t" + this.errorName
             + "\nDesc: \t" + this.errorDescription
             + "\nLine: \t" + this.errorLine
             + "\nChar: \t" + this.errorChar;
    }
}

/**
 * @type {() => vscode.OutputChannel}
 */
let getOutputChannel;

/**
 * @type {() => void}
 */
let disposeOutputChannel;
{
    /**
     * @type {vscode.OutputChannel?}
     */
    let ourChannel = null;
    getOutputChannel = () => {
        if (ourChannel === null)
            ourChannel = vscode.window.createOutputChannel(EXTENSION_DISPLAY_NAME);
        return ourChannel;
    }

    disposeOutputChannel = () => {
        if (ourChannel !== null) {
            ourChannel.dispose();
            ourChannel = null;
        }
    }
}

/**
 * @param {Any} output
 * @param {Boolean} [preserveFocus]
 */
const outputPrint = (output, preserveFocus) => {
    const channel = getOutputChannel();
    channel.append(new String(output).trimEnd() + "\n");
    channel.show(preserveFocus);
}

/**
 * @param {Any} output
 * @param {Boolean} [preserveFocus]
 */
const outputClearPrint = (output, preserveFocus = true) => {
    const channel = getOutputChannel();
    channel.clear();
    outputPrint(output, preserveFocus);
}

/**
 * @param {String?} path
 * @returns {Boolean}
 */
const isValidFile = (path) => {
    if (path === null || path.length === 0 || !fs.existsSync(path))
        return false;

    const fileStats = fs.statSync(path);
    if (fileStats.isFile())
        return true;
    return false;
}

/**
 * @returns {String?}
 */
const getJavaPath = () => {
    const settings = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const javaPath = settings.get("javaPath");
    if (javaPath.length > 0) {
        if (isValidFile(javaPath)) return javaPath;
        return null;
    }

    try {
        cp.execSync("java -version");
        return "java";
    } catch (err) { }

    return null;
}

/**
 * @returns {String?}
 */
const getPEMUPath = () => {
    const settings = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const jarPath = settings.get("pemuJarPath");
    if (jarPath.length > 0 && isValidFile(jarPath)) return jarPath;
    return null;
}

/**
 * @param {String?} [filePath]
 * @param {String?} [bitCount]
 * @param {Boolean} [execSync]
 * @param {async (err: cp.ExecException?, stdout: String, stderr: String) => { }} [execOutput]
 * @param {...String} [pemuArguments]
 * @returns {Boolean}
 */
const runFileWithPEMU = async (filePath = undefined, bitCount = undefined, execSync = true, execOutput = async () => { }, ...pemuArguments) => {
    const javaPath = getJavaPath();
    if (javaPath === null) {
        outputClearPrint(EXTENSION_INVALID_JAVA_PATH);
        return false;
    }

    const jarPath = getPEMUPath();
    if (jarPath === null) {
        outputClearPrint(EXTENSION_INVALID_JAR_PATH);
        return false;
    }

    if (filePath === undefined) {
        if (vscode.window.activeTextEditor === undefined) {
            outputClearPrint(EXTENSION_NO_FILE_OPEN);
            return false;
        }
    
        const documentURI = vscode.window.activeTextEditor.document.uri;
        if (documentURI.scheme !== "file") {
            outputClearPrint(EXTENSION_UNSUPPORTED_URI_SCHEME);
            return false;
        }
        filePath = documentURI.fsPath;
    }

    if (bitCount === undefined) {
        bitCount = await vscode.window.showQuickPick(
            PEMU_WORD_SIZES, { "canPickMany": false, "placeHolder": EXTENSION_WORD_SIZE_PICK }
        );
        if (bitCount === undefined) return false;
    }

    let execString = "\"" + javaPath + "\" -jar \"" + jarPath + "\"";
    if (filePath !== null) execString += " -p \"" + filePath + "\"";
    if (bitCount !== null) execString += " -b " + bitCount;
    if (pemuArguments.length > 0) execString += " " + pemuArguments.join(" ");

    if (execSync) {
        let stdout = "";
        let stderr = "";

        try {
            stdout = cp.execSync(execString, { "encoding": "utf-8", "stdio": "pipe" });
        } catch (_stderr) {
            stderr = _stderr;
        }

        await execOutput(null, stdout, stderr);
    } else {
        cp.exec(execString, execOutput);
    }
}

const COMMANDS = {
    "verifyCode": async () => {
        await runFileWithPEMU(undefined, undefined, true, async (err, stdout, stderr) => {
            if (stderr.length > 0) {
                outputClearPrint(stderr);
                return;
            }

            stdout = stdout.trim();
            const lines = stdout.split("\n");
            let pemuError = null;

            for (const line of lines) {
                pemuError = PEMUError.createFromString(line);
                if (pemuError !== null) break;
            }

            if (pemuError === null) {
                outputClearPrint(stdout);
            } else {
                if (settings.get("gotoError")) {
                    const errorPos = pemuError.getPosition();
                    const fileName = pemuError.getFileName();
                    if (errorPos !== null && fileName !== null) {
                        const fileMatches = await vscode.workspace.findFiles("*/" + fileName, undefined, 1);
                        if (fileMatches.length > 0) {
                            const sourceFile = fileMatches[0];
                            const sourceDocument = await vscode.workspace.openTextDocument(sourceFile);
                            const textEditor = await vscode.window.showTextDocument(sourceDocument, false);
                            textEditor.selections = [
                                new vscode.Selection(errorPos, errorPos)
                            ];
                        }
                    }
                }

                outputClearPrint(
                    pemuError.toString()
                );
            }
        }, "-cl -sw -v")
    },
    "openFile": async (filePath) => {
        await runFileWithPEMU(filePath, null, false, async (err, stdout, stderr) => {
            if (err !== null) {
                outputClearPrint(err);
                outputPrint(stderr);
            } else if (stderr.length > 0) {
                outputClearPrint(stderr);
            }
        });
    },
    "open": async () => await COMMANDS.openFile(null)
}

const getPackageCommand = (commandID) => {
    return PACKAGE.contributes.commands.find(command => command.command === commandID);
}

/**
 * @typedef {Object} StatusBarItemOptions
 * @property {vscode.StatusBarAlignment} [alignment]
 * @property {Number} [priority]
 * @property {vscode.ThemeColor} [color]
 * @property {String} [command]
 * @property {String} [text]
 * @property {String} [tooltip]
 */

/**
 * @type {{item: vscode.StatusBarItem, lang: String|undefined}[]}
 */
const STATUS_BAR_ITEMS = [ ];

/**
 * @param {String?} [languageID] If null the item will always be shown
 * @param {StatusBarItemOptions} [options]
 */
const addStatusBarItem = (languageID, options = { }) => {
    const statusBarItem = vscode.window.createStatusBarItem(options.alignment, options.priority);
    if (options.color !== undefined)
        statusBarItem.color = options.color;
    if (options.command !== undefined)
        statusBarItem.command = options.command;
    if (options.text !== undefined)
        statusBarItem.text = options.text;
    if (options.tooltip !== undefined)
        statusBarItem.tooltip = options.tooltip;
    STATUS_BAR_ITEMS.push(
        {
            "item": statusBarItem,
            "lang": languageID
        }
    );
}

/**
 * @param {vscode.TextEditor} [editor]
 */
const updateItems = editor => {
    const hideAll = !vscode.workspace.getConfiguration(EXTENSION_NAME).get("statusBarButtons");
    for (const barItem of STATUS_BAR_ITEMS) {
        if (hideAll) {
            barItem.item.hide();
        } else if (barItem.lang === null) {
            barItem.item.show();
        } else if (editor === undefined) {
            barItem.item.hide();
        } else if (barItem.lang === undefined || barItem.lang === editor.document.languageId) {
            barItem.item.show();
        } else {
            barItem.item.hide();
        }
    }
}

/**
 * @param {vscode.ExtensionContext} context
 */
const registerStatusBarItems = (context) => {
    for (const barItem of STATUS_BAR_ITEMS)
        context.subscriptions.push(barItem.item);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateItems),
        vscode.workspace.onDidChangeConfiguration(
            cfg => {
                if (cfg.affectsConfiguration(EXTENSION_NAME))
                    updateItems(vscode.window.activeTextEditor);
            }
        )
    );

    updateItems(vscode.window.activeTextEditor);
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    for (const command of Object.keys(COMMANDS)) {
        context.subscriptions.push(
            vscode.commands.registerCommand(
                EXTENSION_NAME + "." + command, COMMANDS[command]
            )
        );
    }

    const verifyCode = getPackageCommand(EXTENSION_NAME + ".verifyCode");
    const openFile = getPackageCommand(EXTENSION_NAME + ".openFile");
    const open = getPackageCommand(EXTENSION_NAME + ".open");

    addStatusBarItem(PEMU_LANGUAGE_ID, {
        "alignment": vscode.StatusBarAlignment.Right,
        "command": verifyCode.command,
        "priority": 2,
        "text": verifyCode.category + ": " + verifyCode.title,
        "tooltip": verifyCode.tooltip
    });

    addStatusBarItem(PEMU_LANGUAGE_ID, {
        "alignment": vscode.StatusBarAlignment.Right,
        "command": openFile.command,
        "priority": 1,
        "text": openFile.category + ": " + openFile.title,
        "tooltip": openFile.tooltip
    });

    addStatusBarItem(null, {
        "alignment": vscode.StatusBarAlignment.Right,
        "command": open.command,
        "priority": 0,
        "text": open.category + ": " + open.title,
        "tooltip": open.tooltip
    });
    
    registerStatusBarItems(context);
}

function deactivate() {
    disposeOutputChannel();
}

module.exports = {
    activate, deactivate
}
