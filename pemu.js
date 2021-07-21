
const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const PACKAGE = require("./package.json");

const EXTENSION_NAME = PACKAGE.name;
const EXTENSION_DISPLAY_NAME = PACKAGE.displayName;

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
 * @param {String} output
 * @param {Boolean} [preserveFocus]
 */
const outputClearPrint = (output, preserveFocus = true) => {
    const channel = getOutputChannel();
    channel.clear();
    channel.append(output);
    if (!output.endsWith("\n")) channel.append("\n");
    channel.show(preserveFocus);
}

/**
 * @param {String?} path
 * @returns {Boolean}
 */
const isValidFile = (path) => {
    if (path === null || path === "" || !fs.existsSync(path))
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
    try {
        cp.execSync("java -version");
        return "java";
    } catch (err) { }

    const settings = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const javaPath = settings.get("javaPath");
    if (isValidFile(javaPath)) return javaPath;
    return null;
}

const COMMANDS = {
    "verifyCode": async () => {
        const javaPath = getJavaPath();
        if (javaPath === null) {
            outputClearPrint("Java couldn't be found, please set its path in the Extension's Settings.");
            return;
        }

        const settings = vscode.workspace.getConfiguration(EXTENSION_NAME);
        const jarPath = settings.get("pemuJarPath");
        if (!isValidFile(jarPath)) {
            outputClearPrint("PEMU Jar path isn't valid, please set it in the Extension's Settings.");
            return;
        }

        if (vscode.window.activeTextEditor === undefined) {
            outputClearPrint("Please open the file you want to verify.");
            return;
        }
        const documentURI = vscode.window.activeTextEditor.document.uri;

        const bitCount = await vscode.window.showQuickPick(
            PEMU_WORD_SIZES, { "canPickMany": false, "placeHolder": "The Processor's Word Size to Verify for." }
        );
        if (bitCount === undefined) return;

        if (documentURI.scheme === "file") {
            try {
                const stdout = cp.execSync(
                    "\"" + javaPath + "\" -jar \"" + jarPath + "\" -cl -sw -v -p \"" + documentURI.fsPath + "\" -b " + bitCount,
                    { "encoding": "utf-8", "stdio": "pipe" }
                ).trim();
    
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
            } catch (stderr) {
                outputClearPrint(stderr);
            }
        }
    }
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
}

function deactivate() {
    disposeOutputChannel();
}

module.exports = {
    activate, deactivate
}
