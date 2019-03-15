import {Observable, Subject, Subscriber, TeardownLogic} from "rxjs";
import {first} from "rxjs/operators";
import {classToPlain, plainToClass, RegisteredEntities, partialClassToPlain, partialPlainToClass} from "@marcj/marshal";
import {
    ClientMessageAll,
    ClientMessageWithoutId,
    Collection,
    EntitySubject,
    ServerMessageActionType,
    ServerMessageAll,
    ServerMessageResult,
    StreamBehaviorSubject
} from "@marcj/glut-core";
import {applyDefaults, eachKey, isArray} from "@marcj/estdlib";
import {EntityState} from "./entity-state";
import {tearDown} from "@marcj/estdlib-rxjs";

export class SocketClientConfig {
    host: string = '127.0.0.1';

    port: number = 8080;

    token: any = undefined;
}

type ActionTypes = { parameters: ServerMessageActionType[], returnType: ServerMessageActionType };

export class AuthorizationError extends Error {
}

export class MessageSubject<T> extends Subject<T> {
    constructor(private teardown: TeardownLogic) {
        super();
    }

    /**
     * Used to unsubscribe from replies regarding this message and closing (completing) the subject.
     * Necessary to avoid memory leaks.
     */
    close() {
        tearDown(this.teardown);
        this.complete();
    }

    async firstAndClose(): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.pipe(first()).subscribe((next) => {
                resolve(next);
            }, (error) => {
                reject(error);
            }, () => {
                //complete
            }).add(() => {
                this.close();
            });
        });
    }
}

//todo, add better argument inference for U
export type Promisify<T> = { [P in keyof T]: T[P] extends (...args: infer U) => infer RT ? RT extends Promise<any> ? T[P] : (...args: U) => Promise<RT> : T[P] };

export class SocketClient {
    public socket?: WebSocket;

    private connected: boolean = false;
    private loggedIn: boolean = false;

    private messageId: number = 0;
    private connectionTries = 0;

    private replies: {
        [messageId: string]: (data: any) => void
    } = {};

    private connectionPromise?: Promise<void>;

    private entityState = new EntityState();
    private config: SocketClientConfig;

    private cachedActionsTypes: {
        [controllerName: string]: { [actionName: string]: ActionTypes }
    } = {};

    public constructor(
        config: SocketClientConfig | Partial<SocketClientConfig> = {},
    ) {
        this.config = config instanceof SocketClientConfig ? config : applyDefaults(SocketClientConfig, config);
    }

    //todo, add better argument inference for U
    public controller<T>(name: string): Promisify<T> {
        const t = this;

        const o = new Proxy(this, {
            get: (target, propertyName) => {
                return function () {
                    const actionName = String(propertyName);
                    const args = Array.prototype.slice.call(arguments);

                    return t.stream(name, actionName, ...args);
                };
            }
        });

        return (o as any) as Promisify<T>;
    }

    protected onMessage(event: MessageEvent) {
        const message = JSON.parse(event.data.toString()) as ServerMessageAll;
        // console.log('onMessage', message);

        if (!message) {
            throw new Error(`Got invalid message: ` + event.data);
        }

        if (message.type === 'entity/remove' || message.type === 'entity/patch' || message.type === 'entity/update' || message.type === 'entity/removeMany') {
            this.entityState.handleEntityMessage(message);
            return;
        } else if (message.type === 'channel') {
            //not built in yet
        } else {
            if (this.replies[message.id]) {
                this.replies[message.id](message);
            } else {
                console.error(`No replies callback for message ${message.id}: ` + JSON.stringify(message));
            }
        }
    }

    public async onConnected(): Promise<void> {

    }

    protected async doConnect(): Promise<void> {
        const port = this.config.port;
        this.connectionTries++;
        const url = this.config.host.startsWith('ws+unix') ? this.config.host : 'ws://' + this.config.host + ':' + port;

        const socket = this.socket = new WebSocket(url);
        socket.onmessage = (event: MessageEvent) => {
            this.onMessage(event);
        };
        // socket.onmessage = (event: { data: WebSocket.Data; type: string; target: WebSocket }) => this.onMessage(event);

        return new Promise<void>((resolve, reject) => {
            socket.onerror = (error: any) => {
                if (this.connected) {
                    // this.emit('offline');
                }

                this.connected = false;
                if (this.connectionTries === 1) {
                    reject(new Error(`Could not connect to ${this.config.host}:${port}. Reason: ${error.message}`));
                }
            };

            socket.onopen = async () => {
                if (this.config.token) {
                    if (!await this.authenticate()) {
                        reject(new AuthorizationError());
                        return;
                    }
                }

                await this.onConnected();
                this.connected = true;
                this.connectionTries = 0;
                // this.emit('online');
                resolve();
            };
        });
    }

    /**
     * Simply connect with login using the token, without auto re-connect.
     */
    public async connect(): Promise<void> {
        while (this.connectionPromise) {
            await this.connectionPromise;
        }

        if (this.connected) {
            return;
        }

        this.connectionPromise = this.doConnect();

        try {
            await this.connectionPromise;
        } finally {
            delete this.connectionPromise;
        }
    }

    public async getActionTypes(controller: string, actionName: string): Promise<ActionTypes> {
        if (!this.cachedActionsTypes[controller]) {
            this.cachedActionsTypes[controller] = {};
        }

        if (!this.cachedActionsTypes[controller][actionName]) {
            const reply = await this.sendMessage({
                name: 'actionTypes',
                controller: controller,
                action: actionName
            }).firstAndClose();

            if (reply.type === 'error') {
                throw new Error(reply.error);
            } else if (reply.type === 'actionTypes/result') {
                this.cachedActionsTypes[controller][actionName] = {
                    parameters: reply.parameters,
                    returnType: reply.returnType
                };
            } else {
                throw new Error('Invalid message returned: ' + JSON.stringify(reply));
            }
        }

        return this.cachedActionsTypes[controller][actionName];
    }

    public async stream(controller: string, name: string, ...args: any[]): Promise<any> {
        return new Promise<any>(async (resolve, reject) => {
            try {
                //todo, handle reject when we sending message fails

                let returnValue: any;

                const self = this;
                const subscribers: { [subscriberId: number]: Subscriber<any> } = {};
                let subscriberIdCounter = 0;
                let streamBehaviorSubject: StreamBehaviorSubject<any> | undefined;

                const types = await this.getActionTypes(controller, name);

                for (const i of eachKey(args)) {
                    const type = types.parameters[i];
                    if (type.type === 'Entity' && type.entityName) {
                        if (!RegisteredEntities[type.entityName]) {
                            throw new Error(`Action's parameter ${controller}::${name}:${i} has invalid entity referenced ${type.entityName}.`);
                        }

                        if (type.partial) {
                            args[i] = partialClassToPlain(RegisteredEntities[type.entityName], args[i]);
                        } else {
                            args[i] = classToPlain(RegisteredEntities[type.entityName], args[i]);
                        }
                    }
                }

                const subject = this.sendMessage({
                    name: 'action',
                    controller: controller,
                    action: name,
                    args: args
                });

                function deserializeResult(next: any): any {
                    if (types.returnType.type === 'Date') {
                        return new Date(next);
                    }

                    if (types.returnType.type === 'Entity') {
                        const classType = RegisteredEntities[types.returnType.entityName!];

                        if (!classType) {
                            reject(new Error(`Entity ${types.returnType.entityName} now known on client side.`));
                            subject.close();
                            return;
                        }

                        if (types.returnType.partial) {
                            if (isArray(next)) {
                                return next.map(v => partialPlainToClass(classType, v));
                            } else {
                                return partialPlainToClass(classType, next);
                            }
                        } else {
                            if (isArray(next)) {
                                return next.map(v => plainToClass(classType, v));
                            } else {
                                return plainToClass(classType, next);
                            }
                        }
                    }

                    return next;
                }

                subject.subscribe((reply) => {
                    if (reply.type === 'type') {
                        if (reply.returnType === 'subject') {
                            streamBehaviorSubject = new StreamBehaviorSubject(reply.data);
                            resolve(streamBehaviorSubject);
                        }

                        if (reply.returnType === 'entity') {
                            if (reply.item) {
                                const classType = RegisteredEntities[reply.entityName || ''];

                                if (!classType) {
                                    throw new Error(`Entity ${reply.entityName} not known. (known: ${Object.keys(RegisteredEntities).join(',')})`);
                                }

                                if (this.entityState.hasEntitySubject(classType, reply.item.id)) {
                                    const subject = this.entityState.handleEntity(classType, reply.item);
                                    resolve(subject);
                                } else {
                                    //it got created, so we subscribe only once to notify server about
                                    //unused EntitySubject when completed.
                                    const subject = this.entityState.handleEntity(classType, reply.item);
                                    subject.addTearDown(() => {
                                        //user unsubscribed the entity subject, so we stop syncing changes
                                        self.send({
                                            id: reply.id,
                                            name: 'entity/unsubscribe'
                                        });
                                    });

                                    resolve(subject);
                                }
                            } else {
                                resolve(new EntitySubject(undefined));
                            }
                        }

                        if (reply.returnType === 'observable') {
                            returnValue = new Observable((observer) => {
                                const subscriberId = ++subscriberIdCounter;

                                subscribers[subscriberId] = observer;

                                self.send({
                                    id: reply.id,
                                    name: 'observable/subscribe',
                                    subscribeId: subscriberId
                                });

                                return {
                                    unsubscribe(): void {
                                        self.send({
                                            id: reply.id,
                                            name: 'observable/unsubscribe',
                                            subscribeId: subscriberId
                                        });
                                    }
                                };
                            });
                            resolve(returnValue);
                        }

                        if (reply.returnType === 'collection') {
                            const classType = RegisteredEntities[reply.entityName];
                            if (!classType) {
                                throw new Error(`Entity ${reply.entityName} not known. (known: ${Object.keys(RegisteredEntities).join(',')})`);
                            }

                            const collection = new Collection<any>(classType);
                            returnValue = collection;

                            collection.addTeardown(() => {
                                this.entityState.unsubscribeCollection(collection);

                                //collection unsubscribed, so we stop syncing changes
                                self.send({
                                    id: reply.id,
                                    name: 'collection/unsubscribe'
                                });
                            });
                            resolve(collection);
                        }
                    }

                    if (reply.type === 'next/json') {
                        resolve(deserializeResult(reply.next));
                    }

                    if (reply.type === 'next/observable') {

                        if (subscribers[reply.subscribeId]) {
                            subscribers[reply.subscribeId].next(deserializeResult(reply.next));
                        }
                    }

                    if (reply.type === 'next/subject') {
                        if (streamBehaviorSubject) {
                            streamBehaviorSubject.next(deserializeResult(reply.next));
                        }
                    }

                    if (reply.type === 'next/collection') {
                        this.entityState.handleCollectionNext(returnValue, reply.next);
                    }

                    if (reply.type === 'complete') {
                        if (returnValue instanceof Collection) {
                            returnValue.complete();
                        }

                        if (streamBehaviorSubject) {
                            streamBehaviorSubject.complete();
                        }

                        subject.close();
                    }

                    if (reply.type === 'error') {
                        //todo, try to find a way to get correct Error instance as well.
                        const error = new Error(reply.error);

                        if (returnValue instanceof Collection) {
                            returnValue.error(error);
                        } else if (streamBehaviorSubject) {
                            streamBehaviorSubject.error(error);
                        } else {
                            reject(error);
                        }

                        subject.close();
                    }

                    if (reply.type === 'error/observable') {
                        //todo, try to find a way to get correct Error instance as well.
                        const error = new Error(reply.error);
                        if (subscribers[reply.subscribeId]) {
                            subscribers[reply.subscribeId].error(error);
                        }

                        delete subscribers[reply.subscribeId];
                        subject.close();
                    }

                    if (reply.type === 'complete/observable') {
                        if (subscribers[reply.subscribeId]) {
                            subscribers[reply.subscribeId].complete();
                        }

                        delete subscribers[reply.subscribeId];
                        subject.close();
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    public send(message: ClientMessageAll) {
        if (!this.socket) {
            throw new Error('Socket not created yet');
        }

        this.socket.send(JSON.stringify(message));
    }

    private sendMessage<T extends ServerMessageResult>(
        messageWithoutId: ClientMessageWithoutId
    ): MessageSubject<T> {
        this.messageId++;
        const messageId = this.messageId;

        const message = {
            id: messageId, ...messageWithoutId
        };

        const subject = new MessageSubject<T>(() => {
            delete this.replies[messageId];
        });

        this.replies[messageId] = (reply: T) => {
            subject.next(reply);
        };

        this.connect().then(() => this.send(message), (error) => {
            subject.error(error);
        });

        return subject;
    }

    private async authenticate(): Promise<boolean> {
        const reply = await this.sendMessage({
            name: 'authenticate',
            token: this.config.token,
        }).firstAndClose();

        if (reply.type === 'authenticate/result') {
            this.loggedIn = reply.result;
        }

        if (reply.type === 'error') {
            throw new Error(reply.error);
        }

        return this.loggedIn;
    }

    public disconnect() {
        this.connected = false;
        this.loggedIn = false;

        if (this.socket) {
            this.socket.close();
            delete this.socket;
        }
    }
}
