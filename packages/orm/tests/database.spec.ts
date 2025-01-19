import { expect, test } from '@jest/globals';
import { MemoryDatabaseAdapter } from '../src/memory-db.js';
import { Database } from '../src/database.js';
import { deserialize, entity, PrimaryKey, t, validate, ValidatorError } from '@deepkit/type';

test('memory-db', async () => {
    function MinLength(minLength: number) {
        return (v: string): ValidatorError | void => {
            if (v.length < minLength) return new ValidatorError('length', `Min length is ${minLength}`);
        };
    }

    @entity.name('User')
    class s {
        id: number & PrimaryKey = 0;
        @t.validate(MinLength(5))
        username!: string;
    }

    {
        const item = deserialize<s>({ id: 2, username: '123456' });
        expect(validate<s>(item)).toEqual([]);
    }

    {
        const item = deserialize<s>({ id: 2, username: '1234' });
        expect(validate<s>(item)).toEqual([{ code: 'length', message: 'Min length is 5', path: 'username', value: '1234' }]);
    }

    const database = new Database(new MemoryDatabaseAdapter());

    await database.persist(deserialize<s>({ id: 2, username: '123456' }));
    await expect(() => database.persist(deserialize<s>({ id: 2, username: '123' }))).rejects.toThrow('Validation error for class User:\nusername(length): Min length is 5');

    await database.persist(deserialize<s>({ id: 3, username: 'Peter' }));
    await database.persist(deserialize<s>({ id: 4, username: 'JohnLong' }));

    const item = await database.query(s).findOne();
    expect(item.id).toBe(2);
    expect(item.username).toBe('123456');

    await database.query(s).filter({ username: '123456' }).deleteOne();
    expect(await (await database.query(s).find()).length).toBe(2);

    await database.query(s).filter({ username: 'Peter' }).patchOne({ username: 'Peter2' });
    expect((await database.query(s).filter({ id: 3 }).findOne()).username).toBe('Peter2');

    await database.query(s).deleteMany();
    expect(await (await database.query(s).find()).length).toBe(0);
});

test('persistAs', async () => {
    interface X {
        id: number & PrimaryKey;
        name: string;
    }

    interface Y {
        id: number & PrimaryKey;
        name: string;
    }

    const database = new Database(new MemoryDatabaseAdapter());
    database.register<X>({ name: 'x' });
    database.register<Y>({ name: 'y' });

    await database.persistAs<X>([{ id: 1, name: 'Peter' }, { id: 2, name: 'Peter2' }]);
    await database.persistAs<X>([{ id: 3, name: 'Peter3' }]);
    await database.persistAs<Y>([{ id: 1, name: 'John' }]);

    expect(await database.query<X>().count()).toBe(3);
    expect(await database.query<Y>().count()).toBe(1);

    await database.removeAs<X>([{ id: 1, name: 'Peter' }]);
    expect(await database.query<X>().count()).toBe(2);

    await database.removeAs<Y>([{ id: 1, name: 'John' }]);
    expect(await database.query<Y>().count()).toBe(0);
});
