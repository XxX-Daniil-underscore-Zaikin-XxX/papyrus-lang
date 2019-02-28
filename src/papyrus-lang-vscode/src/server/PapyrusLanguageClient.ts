import { LanguageClient, Disposable, TextDocumentIdentifier } from 'vscode-languageclient';
import { workspace } from 'vscode';

import { DocumentScriptInfo, documentScriptInfoRequestType } from './messages/DocumentScriptInfo';
import { DocumentSyntaxTree, documentSyntaxTreeRequestType } from './messages/DocumentSyntaxTree';

export interface IPapyrusLanguageClientOptions {
    executablePath: string;
}

export class PapyrusLanguageClient {
    private readonly _client: LanguageClient;
    private readonly _fsWatcher: Disposable;

    constructor(options: IPapyrusLanguageClientOptions) {
        this._fsWatcher = workspace.createFileSystemWatcher('**/*.{flg,ppj,psc}');
        this._client = new LanguageClient('papyrus', 'Papyrus Language Service', null, null); // TODO: Options
    }

    async start() {
        if (this._client.needsStart()) {
            this._client.start();
            await this._client.onReady();
        }
    }

    async stop() {
        if (this._client.needsStop()) {
            await this._client.stop();
        }
    }

    requestScriptInfo(uri: string): Thenable<DocumentScriptInfo> {
        return this._client.sendRequest(documentScriptInfoRequestType.type, {
            textDocument: TextDocumentIdentifier.create(uri),
        });
    }

    requestSyntaxTree(uri: string): Thenable<DocumentSyntaxTree> {
        return this._client.sendRequest(documentSyntaxTreeRequestType.type, {
            textDocument: TextDocumentIdentifier.create(uri),
        });
    }

    dispose() {
        this.stop();
        this._fsWatcher.dispose();
    }
}
