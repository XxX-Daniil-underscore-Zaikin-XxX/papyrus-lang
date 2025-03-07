import {
    DebugAdapterDescriptorFactory,
    DebugAdapterExecutable,
    DebugAdapterDescriptor,
    debug,
    Disposable,
    window,
    commands,
    Uri,
    env,
} from 'vscode';
import {
    PapyrusGame,
    getDisplayNameForGame,
    getScriptExtenderName,
    getScriptExtenderUrl,
    getShortDisplayNameForGame,
} from '../PapyrusGame';
import { ICreationKitInfoProvider } from '../CreationKitInfoProvider';
import { IExtensionConfigProvider } from '../ExtensionConfigProvider';
import { take } from 'rxjs/operators';
import { IPapyrusDebugSession } from './PapyrusDebugSession';
import { toCommandLineArgs, getGameIsRunning } from '../Utilities';
import { IPathResolver } from '../common/PathResolver';
import { IDebugSupportInstallService, DebugSupportInstallState } from './DebugSupportInstallService';
import { ILanguageClientManager } from '../server/LanguageClientManager';
import { showGameDisabledMessage, showGameMissingMessage } from '../features/commands/InstallDebugSupportCommand';
import { inject, injectable } from 'inversify';

const noopExecutable = new DebugAdapterExecutable('node', ['-e', '""']);

export interface IDebugToolArguments {
    port?: number;
    projectPath?: string;
    defaultScriptSourceFolder?: string;
    defaultAdditionalImports?: string;
    creationKitInstallPath: string;
    relativeIniPaths: string[];
    clientProcessId: number;
    remotesInstallPath: string;
}

function getDefaultPortForGame(game: PapyrusGame) {
    return game === PapyrusGame.fallout4 ? 2077 : 43201;
}

@injectable()
export class PapyrusDebugAdapterDescriptorFactory implements DebugAdapterDescriptorFactory {
    private readonly _languageClientManager: ILanguageClientManager;
    private readonly _creationKitInfoProvider: ICreationKitInfoProvider;
    private readonly _configProvider: IExtensionConfigProvider;
    private readonly _pathResolver: IPathResolver;
    private readonly _debugSupportInstaller: IDebugSupportInstallService;
    private readonly _registration: Disposable;

    constructor(
        @inject(ILanguageClientManager) languageClientManager: ILanguageClientManager,
        @inject(ICreationKitInfoProvider) creationKitInfoProvider: ICreationKitInfoProvider,
        @inject(IExtensionConfigProvider) configProvider: IExtensionConfigProvider,
        @inject(IPathResolver) pathResolver: IPathResolver,
        @inject(IDebugSupportInstallService) debugSupportInstaller: IDebugSupportInstallService
    ) {
        this._languageClientManager = languageClientManager;
        this._creationKitInfoProvider = creationKitInfoProvider;
        this._configProvider = configProvider;
        this._pathResolver = pathResolver;
        this._debugSupportInstaller = debugSupportInstaller;

        this._registration = debug.registerDebugAdapterDescriptorFactory('papyrus', this);
    }

    private async ensureReadyFlow(game: PapyrusGame) {
        const installState = await this._debugSupportInstaller.getInstallState(game);

        switch (installState) {
            case DebugSupportInstallState.incorrectVersion: {
                const ignoreVersion = (await this._configProvider.config.pipe(take(1)).toPromise())[game]
                    .ignoreDebuggerVersion;

                if (ignoreVersion) {
                    break;
                }

                const selectedUpdateOption = await window.showWarningMessage(
                    `The Papyrus debugging support ${getScriptExtenderName(game)} plugin needs to be updated.`,
                    'Update',
                    'Remind Me Later',
                    'Cancel'
                );

                if (selectedUpdateOption === 'Update') {
                    commands.executeCommand(`papyrus.${game}.installDebuggerSupport`);
                    return false;
                }

                if (selectedUpdateOption === 'Cancel' || selectedUpdateOption === undefined) {
                    return false;
                }

                break;
            }
            case DebugSupportInstallState.notInstalled: {
                const getExtenderOption = `Get ${getScriptExtenderName(game)}`;
                const installOption = `Install ${getScriptExtenderName(game)} Plugin`;

                const selectedInstallOption = await window.showInformationMessage(
                    `Papyrus debugging support requires a plugin for ${getDisplayNameForGame(
                        game
                    )} Script Extender (${getScriptExtenderName(
                        game
                    )}) to be installed. After installation has completed, launch ${getShortDisplayNameForGame(
                        game
                    )} with ${getScriptExtenderName(game)} and wait until the main menu has loaded.`,
                    getExtenderOption,
                    installOption,
                    'Cancel'
                );

                switch (selectedInstallOption) {
                    case installOption:
                        commands.executeCommand(`papyrus.${game}.installDebuggerSupport`);
                        break;
                    case getExtenderOption:
                        env.openExternal(Uri.parse(getScriptExtenderUrl(game)));
                        break;
                }

                return false;
            }
            case DebugSupportInstallState.gameDisabled:
                showGameDisabledMessage(game);
                return false;
            case DebugSupportInstallState.gameMissing:
                showGameMissingMessage(game);
                return false;
        }

        if (!(await getGameIsRunning(game))) {
            const selectedGameRunningOption = await window.showWarningMessage(
                `Make sure that ${getDisplayNameForGame(game)} is running and is either in-game or at the main menu.`,
                'Continue',
                'Cancel'
            );

            if (selectedGameRunningOption !== 'Continue') {
                return false;
            }
        }

        return true;
    }

    async createDebugAdapterDescriptor(
        session: IPapyrusDebugSession,
        _executable: DebugAdapterExecutable
    ): Promise<DebugAdapterDescriptor> {
        const game = session.configuration.game;

        if (game !== PapyrusGame.fallout4 && game !== PapyrusGame.skyrimSpecialEdition) {
            throw new Error(`'${game}' is not supported by the Papyrus debugger.`);
        }

        if (!(await this.ensureReadyFlow(game))) {
            session.configuration.noop = true;

            return noopExecutable;
        }

        const config = (await this._configProvider.config.pipe(take(1)).toPromise())[game];
        const creationKitInfo = await this._creationKitInfoProvider.infos.get(game)!.pipe(take(1)).toPromise();

        if (!creationKitInfo.resolvedInstallPath) {
            throw new Error(`Creation Kit install path for ${getDisplayNameForGame(game)} is not configured.`);
        }

        const toolArguments: IDebugToolArguments = {
            port: session.configuration.port || getDefaultPortForGame(game),
            projectPath: session.configuration.projectPath,
            creationKitInstallPath: creationKitInfo.resolvedInstallPath,
            relativeIniPaths: config.creationKitIniFiles,
            defaultScriptSourceFolder: creationKitInfo.config.Papyrus?.sScriptSourceFolder,
            defaultAdditionalImports: creationKitInfo.config.Papyrus?.sAdditionalImports,
            clientProcessId: Number.parseInt(process.env.VSCODE_PID!),
            remotesInstallPath: await this._pathResolver.getPyroRemPath()
        };

        const toolPath = await this._pathResolver.getDebugToolPath(game);
        const commandLineArgs = toCommandLineArgs(toolArguments);

        const outputChannel = (await this._languageClientManager.getLanguageClientHost(session.configuration.game))
            .outputChannel;
        outputChannel?.appendLine(
            `Debug session: Launching debug adapter client: ${toolPath} ${commandLineArgs.join(' ')}`
        );

        return new DebugAdapterExecutable(toolPath, commandLineArgs);
    }

    dispose() {
        this._registration.dispose();
    }
}
