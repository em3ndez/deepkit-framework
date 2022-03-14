/*
 * Deepkit Framework
 * Copyright (C) 2021 Deepkit UG, Marc J. Schmidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 *
 * You should have received a copy of the MIT License along with this program.
 */

import { BenchSuite } from '../../bench';
import { serializeFunction, deserializeFunction } from '@deepkit/type';

class Model {
    ready?: boolean;

    tags: string[] = [];

    priority: number = 0;

    constructor(
        public id: number,
        public name: string
    ) {
    }
}

const serializer = serializeFunction<Model>();
const deserializer = deserializeFunction<Model>();

export async function main() {
    const suite = new BenchSuite('deepkit');
    const plain = {
        name: 'name',
        id: 2,
        tags: ['a', 'b', 'c'],
        priority: 5,
        ready: true,
    };

    suite.add('deserialize', () => {
        deserializer(plain);
    });

    const item = deserializer(plain);
    suite.add('serialize', () => {
        serializer(item);
    });

    suite.run();
}
