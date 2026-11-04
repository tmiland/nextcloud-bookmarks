'use strict';
(function () {
  const status = document.getElementById('status');
  document.getElementById('seed').addEventListener('click', async () => {
    try {
      const existing = await browser.bookmarks.search({ title: 'Import Test' });
      for (const node of existing) {
        if (node.type === 'folder') await browser.bookmarks.removeTree(node.id);
      }
      const folder = await browser.bookmarks.create({ title: 'Import Test', parentId: 'toolbar_____' });
      const nested = await browser.bookmarks.create({ title: 'Nested', parentId: folder.id });
      await browser.bookmarks.create({ parentId: folder.id, title: 'Firefox One', url: 'https://firefox-one.example/' });
      await browser.bookmarks.create({ parentId: nested.id, title: 'Firefox Two', url: 'https://firefox-two.example/' });
      await browser.bookmarks.create({ parentId: folder.id, title: 'Duplicate Example', url: 'https://example.com/' });
      status.textContent = 'seeded:' + folder.id;
    } catch (error) {
      status.textContent = 'error:' + error.message;
    }
  });
}());
