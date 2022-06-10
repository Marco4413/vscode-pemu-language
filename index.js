
const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const PACKAGE = require("./package.json");

// [ MIN_VER, MAX_VER ]
// TODO: Change "1.12.0" to "1.13.0" when the latter is released
const EXTENSION_SUPPORTED_PEMU_VERSIONS = [ "1.12.0", "1.13.99" ];

const PEMU_RELEASES_PAGE = "https://github.com/Marco4413/ProcessorEmulator/releases";
const EXTENSION_LOW_VERSION = `
The PEMU version in use is old ({0}), and not supported, please update it to {1}
 - ${PEMU_RELEASES_PAGE}
`.trim();
const EXTENSION_HIGH_VERSION = `
The PEMU version in use is new ({0}), and not supported by this version of the
extension (Max version: {1}), please update the extension or use an older PEMU version.
`.trim();
const EXTENSION_VALID_VERSION = `
The PEMU version in use ({0}) is compatible with this version of the plugin.
`.trim();

const EXTENSION_NAME = PACKAGE.name;
const EXTENSION_DISPLAY_NAME = PACKAGE.displayName;
const EXTENSION_INVALID_JAVA_PATH = "Java couldn't be found, please set its path in the Extension's Settings.";
const EXTENSION_INVALID_JAR_PATH  = "PEMU Jar path isn't valid, please set it in the Extension's Settings.";
const EXTENSION_NO_FILE_OPEN      = "Please open the file you want to perform the command on.";
const EXTENSION_WORD_SIZE_PICK    = "Please pick the Processor's Word Size.";
const EXTENSION_UNSUPPORTED_URI_SCHEME = "File's URI can only be of type \"file\".";

const PEMU_UNSUPPORTED_COMMAND = `
The specified command didn't give any output, maybe your PEMU version isn't up to date!
You can check for a new version at the following link:
 - ${PEMU_RELEASES_PAGE}

If there isn't any new version then either there was an error (I highly doubt it, otherwise
 this message wouldn't have shown) or the feature still needs to be put into an official release.
If you can't live without it the only way is building from source.
`.trim();
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
        const matches = str.match(/^'(.+)': (.+ Error) \((.+):(.+)\): (.+)$/);
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
const outputPrint = (output, preserveFocus = true) => {
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
 * @param {String} str
 * @param {...Any} formats
 * @returns {String}
 */
 const formatString = (str, ...formats) => {
    for (let i = 0; i < formats.length; i++) {
        str = str.replace("{" + i + "}", formats[i]);
    }
    return str;
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
 * @param {(err: cp.ExecException?, stdout: String, stderr: String) => Promise<Void>} [execOutput]
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

    const settings = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const defaultArguments = settings.get("pemuArguments");

    let execString = "\"" + javaPath + "\" -jar \"" + jarPath + "\"";
    if (defaultArguments.length > 0) execString += " " + defaultArguments;
    if (filePath !== null) execString += " -p \"" + filePath + "\"";
    if (bitCount !== null) execString += " -b " + bitCount;
    if (pemuArguments.length > 0) execString += " " + pemuArguments.join(" ");

    outputClearPrint(execString + "\n");
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

/**
 * @param {String} v1
 * @param {String} v2
 * @returns {Number}
 */
const compareVersions = (v1, v2) => {
    const detailedV1 = v1.split(/\./).map(v => Number.parseInt(v));
    const detailedV2 = v2.split(/\./).map(v => Number.parseInt(v));

    const length = Math.max(detailedV1.length, detailedV2.length);
    for (let i = 0; i < length; i++) {
        const d1 = i < detailedV1.length ? detailedV1[i] : 0;
        const d2 = i < detailedV2.length ? detailedV2[i] : 0;
        if (d1 > d2) return 1;
        else if (d1 < d2) return -1;
    }
    return 0;
}

/**
 * @returns {Boolean}
 */
const checkPEMUVersion = async () => {
    let isValid = false;
    await runFileWithPEMU(null, null, true, async (err, stdout, stderr) => {
        const versionMatch = stdout.trim().match(/^.*"(.+)"$/);
        if (versionMatch === null) return;

        const currentVersion = versionMatch[1];
        const minVersion = EXTENSION_SUPPORTED_PEMU_VERSIONS[0];
        const maxVersion = EXTENSION_SUPPORTED_PEMU_VERSIONS[1];
        if (compareVersions(currentVersion, minVersion) < 0) {
            outputPrint(formatString(EXTENSION_LOW_VERSION, currentVersion, minVersion));
            return;
        } else if (compareVersions(currentVersion, maxVersion) > 0) {
            outputPrint(formatString(EXTENSION_HIGH_VERSION, currentVersion, maxVersion));
            return;
        } else outputPrint(formatString(EXTENSION_VALID_VERSION, currentVersion));
        isValid = true;
    }, "-ver");
    return isValid;
}

const COMMANDS = {
    "verifyCode": async (obfuscate = false, bitCount = undefined) => {
        if (!await checkPEMUVersion()) return;

        await runFileWithPEMU(undefined, bitCount, true, async (err, stdout, stderr) => {
            if (err !== null) {
                outputPrint(err);
                outputPrint(stderr);
                return;
            } else if (stderr.length > 0) {
                outputPrint(stderr);
                return;
            }

            stdout = stdout.trim();
            const lines = stdout.split("\n");
            let pemuError = null;
            
            for (let i = lines.length - 1; i >= 0; i--) {
                pemuError = PEMUError.createFromString(lines[i]);
                if (pemuError !== null) break;
            }
            
            if (pemuError === null) {
                outputPrint(stdout.length > 0 ? stdout : PEMU_UNSUPPORTED_COMMAND);
            } else {
                const settings = vscode.workspace.getConfiguration(EXTENSION_NAME);
                if (settings.get("gotoError")) {
                    const errorPos = pemuError.getPosition();
                    const fileName = pemuError.getFileName();
                    if (errorPos !== null && fileName !== null) {
                        const fileMatches = await vscode.workspace.findFiles("**/" + fileName, undefined, 1);
                        if (fileMatches.length > 0) {
                            const sourceFile = fileMatches[0];
                            const sourceDocument = await vscode.workspace.openTextDocument(sourceFile);
                            
                            const textEditor = await vscode.window.showTextDocument(sourceDocument, false);
                            textEditor.selections = [ new vscode.Selection(errorPos, errorPos) ];
                            textEditor.revealRange(
                                new vscode.Range(errorPos, errorPos),
                                vscode.TextEditorRevealType[settings.get("gotoErrorRevealType").replace(/\s+/, "")]
                            );
                        }
                    }
                }

                outputPrint(
                    pemuError.toString()
                );
            }
        }, "-cl -sw -ncas " + (obfuscate ? "-o" : "-v"));
    },
    "obfuscateCode": async () => await COMMANDS.verifyCode(true, "24", PEMU_WORD_SIZES[PEMU_WORD_SIZES.length - 1]),
    "openFile": async (filePath = undefined) => {
        if (!await checkPEMUVersion()) return;
        await runFileWithPEMU(filePath, null, false, async (err, stdout, stderr) => {
            if (err !== null) {
                outputPrint(err);
                outputPrint(stderr);
            } else if (stderr.length > 0) {
                outputPrint(stderr);
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
 * @type {{item: vscode.StatusBarItem,condition: (textEditor: vscode.TextEditor | undefined, settings: vscode.WorkspaceConfiguration) => Boolean}[]}
 */
const STATUS_BAR_ITEMS = [ ];

/**
 * @param {(textEditor: vscode.TextEditor | undefined, settings: vscode.WorkspaceConfiguration) => Boolean} [condition]
 * @param {StatusBarItemOptions} [options]
 */
const addStatusBarItem = (condition = () => true, options = { }) => {
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
        { "item": statusBarItem, condition }
    );
}

/**
 * @param {vscode.TextEditor} [editor]
 */
const updateItems = editor => {
    const settings = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const hideAll = !settings.get("statusBarButtons");
    for (const barItem of STATUS_BAR_ITEMS) {
        if (hideAll || !barItem.condition(editor, settings)) {
            barItem.item.hide();
        } else {
            barItem.item.show();
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
 * 
 * @param {vscode.TextEditor} [editor]
 * @param {String} langID
 * @returns {Boolean}
 */
function isLanguage(editor, langID) {
    return editor !== undefined && editor.document.languageId === langID;
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
    const obfuscateCode = getPackageCommand(EXTENSION_NAME + ".obfuscateCode");
    const openFile = getPackageCommand(EXTENSION_NAME + ".openFile");
    const open = getPackageCommand(EXTENSION_NAME + ".open");

    addStatusBarItem((e, s) => s.get("verifyCodeStatusBarButton") && isLanguage(e, PEMU_LANGUAGE_ID), {
        "alignment": vscode.StatusBarAlignment.Right,
        "command": verifyCode.command,
        "priority": 3,
        "text": verifyCode.category + ": " + verifyCode.title,
        "tooltip": verifyCode.tooltip
    });

    addStatusBarItem((e, s) => s.get("obfuscateCodeStatusBarButton") && isLanguage(e, PEMU_LANGUAGE_ID), {
        "alignment": vscode.StatusBarAlignment.Right,
        "command": obfuscateCode.command,
        "priority": 2,
        "text": obfuscateCode.category + ": " + obfuscateCode.title,
        "tooltip": obfuscateCode.tooltip
    });

    addStatusBarItem((e, s) => s.get("openFileStatusBarButton") && isLanguage(e, PEMU_LANGUAGE_ID), {
        "alignment": vscode.StatusBarAlignment.Right,
        "command": openFile.command,
        "priority": 1,
        "text": openFile.category + ": " + openFile.title,
        "tooltip": openFile.tooltip
    });

    addStatusBarItem((e, s) => s.get("openStatusBarButton"), {
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
