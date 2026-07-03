# Multi Header + Multi Line Template

Use this when one recording should create multiple invoices in one run.

The matching rule is:

- `params` sheet = one row per header
- `multi_line` sheet = one row per line item
- `header_id` = common key used to attach lines to the correct header

Configure the recording with:

```json
{
  "repeatable_blocks": [
    {
      "enabled": true,
      "sheet_name": "multi_line",
      "match_key": "header_id",
      "prompt": "Loop through the line rows for the current header and fill them one by one."
    }
  ]
}
```

`params` sheet:

| header_id | startUrl | username | password | customer_name | customer_number | transaction_date | accounting_date |
| --- | --- | --- | --- | --- | --- | --- | --- |
| INV1 | https://your-oracle-instance.example.com | <username> | <password> | Demo 1 Customer | 111133 | 7/01/26 | 12/31/25 |
| INV2 | https://your-oracle-instance.example.com | <username> | <password> | Demo 2 Customer | 111144 | 7/01/26 | 12/31/25 |

`multi_line` sheet:

| header_id | line_description | quantity | unit_price |
| --- | --- | --- | --- |
| INV1 | Test Line 1 | 10 | 20 |
| INV1 | Test Line 2 | 5 | 15 |
| INV2 | Test Line 3 | 2 | 30 |
| INV2 | Test Line 4 | 1 | 12 |

Equivalent runtime JSON:

```json
{
  "params": [
    {
      "header_id": "INV1",
      "startUrl": "https://your-oracle-instance.example.com",
      "username": "<username>",
      "password": "<password>",
      "customer_name": "Demo 1 Customer",
      "customer_number": "111133",
      "transaction_date": "7/01/26",
      "accounting_date": "12/31/25"
    },
    {
      "header_id": "INV2",
      "startUrl": "https://your-oracle-instance.example.com",
      "username": "<username>",
      "password": "<password>",
      "customer_name": "Demo 2 Customer",
      "customer_number": "111144",
      "transaction_date": "7/01/26",
      "accounting_date": "12/31/25"
    }
  ],
  "multi_line": [
    {
      "header_id": "INV1",
      "line_description": "Test Line 1",
      "quantity": "10",
      "unit_price": "20"
    },
    {
      "header_id": "INV1",
      "line_description": "Test Line 2",
      "quantity": "5",
      "unit_price": "15"
    },
    {
      "header_id": "INV2",
      "line_description": "Test Line 3",
      "quantity": "2",
      "unit_price": "30"
    },
    {
      "header_id": "INV2",
      "line_description": "Test Line 4",
      "quantity": "1",
      "unit_price": "12"
    }
  ]
}
```
