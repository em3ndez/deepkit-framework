import { App, AppModule } from '@deepkit/app';
import { expect, test } from '@jest/globals';
import { HttpModule } from '../src/module.js';
import { HttpKernel } from '../src/kernel.js';
import { HttpRequest } from '../src/model.js';
import { http } from '../src/decorator.js';
import { HttpUnauthorizedError, httpWorkflow } from '../src/http.js';
import { HttpRouterRegistry, RouteConfig } from '../src/router.js';
import { provide } from '@deepkit/injector';

test('module basic functionality', async () => {
    class Controller {
        @http.GET('hello')
        hello() {
            return 'hi';
        }
    }

    const app = new App({
        controllers: [
            Controller,
        ],
        imports: [
            new HttpModule(),
        ],
    });

    const httpKernel = app.get(HttpKernel);

    {
        const response = await httpKernel.request(HttpRequest.GET('/hello'));
        expect(response.statusCode).toBe(200);
        expect(response.json).toContain('hi');
    }
});

test('functional listener', async () => {
    class Controller {
        @http.GET('/hello/:name')
        hello(name: string) {
            return name;
        }
    }

    const gotUrls: string[] = [];
    const app = new App({
        controllers: [
            Controller,
        ],
        listeners: [
            httpWorkflow.onController.listen(event => {
                gotUrls.push(event.request.url || '');
            }),
        ],
        imports: [
            new HttpModule(),
        ],
    });

    const httpKernel = app.get(HttpKernel);

    {
        const response = await httpKernel.request(HttpRequest.GET('/hello/peter'));
        expect(response.statusCode).toBe(200);
        expect(response.json).toBe('peter');
        expect(gotUrls).toEqual(['/hello/peter']);
    }

    {
        const response = await httpKernel.request(HttpRequest.GET('/hello/marie'));
        expect(response.statusCode).toBe(200);
        expect(response.json).toBe('marie');
        expect(gotUrls).toEqual(['/hello/peter', '/hello/marie']);
    }
});

test('functional routes using use()', async () => {
    type User = { id: number, username: string };

    class MyService {
        users: User[] = [{ id: 1, username: 'peter' }, { id: 2, username: 'marie' }];
    }

    const app = new App({
        providers: [MyService],
        imports: [new HttpModule()],
    });

    function userController(router: HttpRouterRegistry, service: MyService) {
        router.get('/users', () => service.users);
        router.get('/users/:id', (id: number) => service.users.find(v => v.id === id));
    }

    app.use(userController);

    const httpKernel = app.get(HttpKernel);

    {
        const response = await httpKernel.request(HttpRequest.GET('/users'));
        expect(response.statusCode).toBe(200);
        expect(response.json).toEqual([{ id: 1, username: 'peter' }, { id: 2, username: 'marie' }]);
    }

    {
        const response = await httpKernel.request(HttpRequest.GET('/users/2'));
        expect(response.statusCode).toBe(200);
        expect(response.json).toEqual({ id: 2, username: 'marie' });
    }
});

test('dynamic route', async () => {
    const app = new App({
        providers: [],
        imports: [new HttpModule()],
    });

    app.configureProvider<HttpRouterRegistry>(router => {
        router.addRoute(new RouteConfig('name', ['GET'], '/users/:id', {
            type: 'function', fn: (id: number) => {
                return { id };
            },
        }));

        router.get('/users', () => {
            return [{ id: 1 }, { id: 2 }];
        });
    });

    const httpKernel = app.get(HttpKernel);

    const response = await httpKernel.request(HttpRequest.GET('/users/2'));
    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({ id: 2 });

    const response2 = await httpKernel.request(HttpRequest.GET('/users'));
    expect(response2.statusCode).toBe(200);
    expect(response2.json).toEqual([{ id: 1 }, { id: 2 }]);
});

test('encapsulated service in router methods', async () => {
    class User {
        constructor(public username: string) {
        }
    }

    class MyController {
        @http.GET('/me')
        me(user: User) {
            return user;
        }
    }

    const myModule = new AppModule();
    myModule.addController(MyController);
    myModule.addProvider(provide<User>({ scope: 'http', useFactory: (req: HttpRequest) => req.store.user }));

    myModule.addListener(httpWorkflow.onAuth.listen((event, request: HttpRequest) => {
        if (!request.headers.authorization) throw new HttpUnauthorizedError();
        request.store.user = new User('Peter:' + request.headers.authorization);
    }));

    const app = new App({
        imports: [new HttpModule(), myModule],
    });

    const httpKernel = app.get(HttpKernel);

    {
        const response = await httpKernel.request(HttpRequest.GET('/me'));
        expect(response.statusCode).toBe(401);
    }

    {
        const response = await httpKernel.request(HttpRequest.GET('/me').header('authorization', '123'));
        expect(response.statusCode).toBe(200);
        expect(response.json).toEqual({ username: 'Peter:123' });
    }
});
