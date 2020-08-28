import {DatabasePersistence, Entity, getInstanceState, getJitChangeDetector, getJITConverterForSnapshot} from '@super-hornet/marshal-orm';
import {ClassSchema, createPartialXToXFunction, getClassToXFunction} from '@super-hornet/marshal';
import {convertPlainQueryToMongo, partialPlainToMongo} from './mapping';
import {ObjectId} from 'mongodb';
import {FilterQuery} from './query.model';
import {MongoClient} from './client/client';
import {InsertCommand} from './client/command/insert';
import {UpdateCommand} from './client/command/update';
import {DeleteCommand} from './client/command/delete';

export class MongoPersistence extends DatabasePersistence {
    constructor(protected client: MongoClient) {
        super();
    }

    async remove<T extends Entity>(classSchema: ClassSchema<T>, items: T[]): Promise<void> {
        if (classSchema.getPrimaryFields().length === 1) {
            const pk = classSchema.getPrimaryField();
            const pkName = pk.name;
            const ids: any[] = [];

            const partialConvert = createPartialXToXFunction(classSchema, 'plain', 'mongo');
            for (const item of items) {
                const converted = partialConvert(getInstanceState(item).getLastKnownPK());
                ids.push(converted[pkName]);
            }
            await this.client.execute(new DeleteCommand(classSchema, {[pkName]: {$in: ids}}));
        } else {
            const fields: any[] = [];
            for (const item of items) {
                fields.push(partialPlainToMongo(classSchema, getInstanceState(item).getLastKnownPK()));
            }
            await this.client.execute(new DeleteCommand(classSchema, {$or: fields}));
        }
    }

    async persist<T extends Entity>(classSchema: ClassSchema<T>, items: T[]): Promise<void> {
        const insert: T[] = [];
        const updates: { q: any, u: any, multi: boolean }[] = [];
        const has_Id = classSchema.hasProperty('_id');
        const converter = getClassToXFunction(classSchema, 'mongo');
        const converterPartial = createPartialXToXFunction(classSchema, 'class', 'mongo');
        const changeDetector = getJitChangeDetector(classSchema);
        const doSnapshot = getJITConverterForSnapshot(classSchema);

        for (const item of items) {
            const state = getInstanceState(item);
            if (state.isKnownInDatabase()) {
                const lastSnapshot = state.getSnapshot();
                const currentSnapshot = doSnapshot(item);
                const changes = changeDetector(lastSnapshot, currentSnapshot, item);
                if (!changes) continue;
                updates.push({
                    q: convertPlainQueryToMongo(classSchema.classType, state.getLastKnownPK() as FilterQuery<T>),
                    u: {$set: converterPartial(changes)},
                    multi: false,
                });
            } else {
                const converted = converter(item);
                if (has_Id && !item['_id']) {
                    converted['_id'] = new ObjectId();
                    item['_id'] = converted['_id'].toHexString();
                }
                insert.push(converted);
            }
        }

        if (insert.length) await this.client.execute(new InsertCommand(classSchema, insert));
        if (updates.length) await this.client.execute(new UpdateCommand(classSchema, updates));
    }
}
