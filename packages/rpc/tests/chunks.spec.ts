import { t } from '@deepkit/type';
import { expect, test } from '@jest/globals';
import 'reflect-metadata';
import { skip } from 'rxjs/operators';
import { DirectClient } from '../src/client/client-direct';
import { rpc } from '../src/decorators';
import { RpcKernel } from '../src/server/kernel';
import { ClientProgress } from '../src/writer';


test('chunks', async () => {
    @rpc.controller('test')
    class TestController {
        @rpc.action()
        uploadBig(@t.type(Buffer) file: Buffer): number {
            return file.length;
        }

        @rpc.action()
        downloadBig(): Buffer {
            return Buffer.alloc(650_000);
        }
    }

    const kernel = new RpcKernel();
    kernel.registerController('test', TestController);

    const client = new DirectClient(kernel);
    const test = client.controller<TestController>('test');

    {
        const progress = ClientProgress.track();

        const stats: number[] = [];
        progress.download.pipe(skip(1)).subscribe((p) => {
            expect(progress.download.total).toBeGreaterThan(0);
            expect(progress.download.current).toBeLessThanOrEqual(progress.download.total);
            expect(progress.download.progress).toBeLessThanOrEqual(1);
            stats.push(progress.download.current);
        });
        const file = await test.downloadBig();
        expect(file.length).toBe(650_000);
        expect(progress.download.done).toBe(true);
        expect(stats).toEqual([
            100_000,
            200_000,
            300_000,
            400_000,
            500_000,
            600_000,
            650_025,
        ]);
        expect(progress.download.progress).toBe(1);
    }

    {
        const uploadFile = Buffer.alloc(550_000);
        const progress = ClientProgress.track();
        const stats: number[] = [];
        progress.upload.pipe(skip(1)).subscribe((p) => {
            expect(progress.upload.total).toBeGreaterThan(0);
            expect(progress.upload.current).toBeLessThanOrEqual(progress.upload.total);
            expect(progress.upload.progress).toBeLessThanOrEqual(1);
            stats.push(progress.upload.current);
        });
        const size = await test.uploadBig(uploadFile);
        expect(size).toBe(550_000);
        expect(stats).toEqual([
            100_000,
            200_000,
            300_000,
            400_000,
            500_000,
            550_082,
        ]);
        expect(progress.upload.done).toBe(true);
        expect(progress.upload.progress).toBe(1);
    }
});