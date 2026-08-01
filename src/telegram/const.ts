export const tmaModeDescription: { [key: string]: string } = {
    test: 'Test an email address',
    white: 'Manage the white list',
    block: 'Manage the block list',
};

export const telegramCommands = [
    {
        command: 'id',
        description: '/id - Get your chat ID',
    },
    {
        command: 'test',
        description: `/test - ${tmaModeDescription.test}`,
    },
    {
        command: 'white',
        description: `/white - ${tmaModeDescription.white}`,
    },
    {
        command: 'block',
        description: `/block - ${tmaModeDescription.block}`,
    },
    {
        command: 'new_route',
        description: '/new_route <prefix> - Create a new email route',
    },
    {
        command: 'list_routes',
        description: '/list_routes - List and delete email routes',
    },
];
