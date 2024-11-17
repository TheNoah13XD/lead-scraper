import { Dataset, createPlaywrightRouter } from 'crawlee';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ request, page, log }) => {
    const pageTitle = await page.title();
    log.info(`URL: ${request.url}, TITLE: ${pageTitle}`);

    const pageContent = await page.evaluate(() => {
        return document.body.innerText;
    });
    log.info(`CONTENT: ${pageContent}`);

    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const emails = pageContent.match(emailRegex) || [];
    log.info(`Found ${emails.length} email(s) on ${request.url}`);

    await Dataset.pushData({
        url: request.loadedUrl,
        pageTitle,
        emails: [...new Set(emails)],
    });
});
