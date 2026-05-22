import re
data = open('templates/index.html', encoding='utf-8').read()
nav_ids = re.findall(r'id="(nav-[^"]+)"', data)
page_ids = re.findall(r'id="(page-[^"]+)"', data)
print("NAV IDs:", nav_ids)
print("PAGE IDs:", page_ids)
