/*
 * Deepkit Framework
 * Copyright (C) 2021 Deepkit UG, Marc J. Schmidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 *
 * You should have received a copy of the MIT License along with this program.
 */

import { ClassType } from '@deepkit/core';
import {
    ClassDecoratorResult,
    createClassDecoratorContext,
    createPropertyDecoratorContext,
    mergeDecorator,
    PropertyDecoratorResult,
    reflect,
} from '@deepkit/type';
import { ControllerDefinition } from './model.js';

export class RpcController {
    // Defaults to the name of the class
    name: string = '';

    classType?: ClassType;

    definition?: ControllerDefinition<any>;

    strictSerialization: boolean = true;
    logValidationErrors: boolean = false;

    actions = new Map<string, RpcAction>();

    getPath(): string {
        const name = this.definition ? this.definition.path : this.name;
        return name || (this.classType ? reflect(this.classType).typeName || this.classType.name : '');
    }
}

export class RpcAction {
    name!: string;
    classType!: ClassType;

    category: string = '';
    description: string = '';

    strictSerialization?: boolean;
    logValidationErrors?: boolean;

    groups: string[] = [];
    data: { [name: string]: any } = {};
}

class RpcClass {
    t = new RpcController;

    controller(nameOrDefinition?: string | ControllerDefinition<any>) {
        if ('string' === typeof nameOrDefinition) {
            this.t.name = nameOrDefinition;
        } else {
            this.t.definition = nameOrDefinition;
        }
    }

    /**
     * Per default strict serialization is enabled. This means that all types
     * defined at the action arguments and return value are enforced.
     *
     * If a different type is passed, an error is thrown. If strictSerialization is
     * disabled, a `any` serializer is used and the action accepts and returns
     * any type. No validation is performed.
     *
     * This is useful for development and debugging, but strict serialization should
     * be enabled in production if all types are known and stable.
     *
     * DISABLE THIS ONLY IF YOU KNOW WHAT YOU ARE DOING AND YOU ARE SURE THAT YOU
     * ARE CORRECTLY SANITIZING THE INPUTS OF YOUR RPC METHODS. OTHERWISE, YOU ARE
     * OPENING YOUR SERVER TO SECURITY VULNERABILITIES.
     */
    strictSerialization(active: boolean = true) {
        this.t.strictSerialization = active;
    }

    /**
     * Logs validation errors to the logger for invalid passed arguments or
     * invalid return values. This also logs if serialization or deserialization
     * failed due to invalid data.
     *
     * Per default disabled.
     *
     * The client receives the validation error as response in any case.
     */
    logValidationErrors(active: boolean = true) {
        this.t.logValidationErrors = active;
    }

    addAction(name: string, action: RpcAction) {
        this.t.actions.set(name, action);
    }

    onDecorator(classType: ClassType) {
        this.t.classType = classType;
    }
}

export const rpcClass: ClassDecoratorResult<typeof RpcClass> = createClassDecoratorContext(RpcClass);

class RpcProperty {
    t = new RpcAction;

    onDecorator(classType: ClassType, property: string | undefined) {
        if (!property) return;
        this.t.name = property;
        this.t.classType = classType;
        rpcClass.addAction(property!, this.t)(classType);
    }

    action() {
    }

    category(name: string) {
        this.t.category = name;
    }

    description(text: string) {
        this.t.description = text;
    }

    group(...groups: string[]) {
        this.t.groups.push(...groups);
    }

    options(options: Partial<RpcAction>) {
        Object.assign(this.t, options);
    }

    /**
     * @see RpcClass.strictSerialization
     */
    strictSerialization(active: boolean = true) {
        this.t.strictSerialization = active;
    }

    /**
     * @see RpcClass.logValidationErrors
     */
    logValidationErrors(active: boolean = true) {
        this.t.logValidationErrors = active;
    }

    data(name: string, value: any) {
        this.t.data[name] = value;
    }
}

export const rpcProperty: PropertyDecoratorResult<typeof RpcProperty> = createPropertyDecoratorContext(RpcProperty);

export const rpc: typeof rpcClass & typeof rpcProperty = mergeDecorator(rpcClass, rpcProperty) as any;

export function getActions<T>(target: ClassType<T>): Map<string, RpcAction> {
    const parent = Object.getPrototypeOf(target);
    const results = parent ? getActions(parent) : new Map<string, RpcAction>();

    const data = rpcClass._fetch(target);
    if (!data) return results;

    for (const action of data.actions.values()) {
        const existing = results.get(action.name)!;
        if (existing) {
            existing.groups.push(...action.groups);
            Object.assign(existing.data, action.data);
        } else {
            if (action.strictSerialization === undefined) {
                action.strictSerialization = data.strictSerialization;
            }
            if (action.logValidationErrors === undefined) {
                action.logValidationErrors = data.logValidationErrors;
            }
            results.set(action.name, action);
        }
    }

    return results;
}
