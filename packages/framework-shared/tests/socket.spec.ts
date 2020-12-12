import {expect, test} from '@jest/globals';
import 'reflect-metadata';
import {MessageSubject} from "../src/client";

test('test MessageSubject', () => {
    let closeCalled = false;

    const subject = new MessageSubject(0);
    subject.subscribe({error: () => {}}).add(() => {
        closeCalled = true;
    });

    subject.complete();
    expect(closeCalled).toBe(true);
});

test('test MessageSubject first', async () => {
    let closeCalled = false;

    const subject = new MessageSubject(0);
    subject.subscribe({error: () => {}}).add(() => {
        closeCalled = true;
    });

    setTimeout(() => {
        subject.next('peter');
    });

    const res = await subject.firstThenClose();
    expect(res).toBe('peter');
    expect(closeCalled).toBe(true);
});
