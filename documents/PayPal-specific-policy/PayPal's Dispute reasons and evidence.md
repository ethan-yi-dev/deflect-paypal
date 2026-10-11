You can determine what evidence to provide for a dispute or chargeback based on its reason.

To defend a dispute or chargeback effectively:

1. Use the Show dispute details response to determine the required evidence. The `reason` and `evidences.evidence_type` parameters denote the dispute reason and the evidence type respectively.
2. Use the Provide evidence endpoint to submit the evidence to PayPal.

Each dispute reason requires specific evidence that helps PayPal review and resolve the case. The following sections list the dispute reasons and the required evidence for each reason.

### MERCHANDISE\_OR\_SERVICE\_NOT\_RECEIVED [#merchandise_or_service_not_received]

The buyer did not receive the merchandise or service.

| Evidence type          | Required evidence                                            |
| ---------------------- | ------------------------------------------------------------ |
| `PROOF_OF_FULFILLMENT` | Provide one of the following to PayPal:Carrier name and tracking number through `evidences.evidence_info.tracking_info.carrier_name` and `evidences.evidence_info.tracking_info.tracking_number` parameters respectively.OrNotes or documents in the `evidences.notes` or `evidences.documents` parameters respectively. For example, a document can be a proof of delivery signature or a proof of receipt copy. For more information about supported files, see Supported file types and sizes. |
| `PROOF_OF_REFUND`      | Pass the refund ID in the `evidences.evidence_info.refund_ids` parameter. |

### MERCHANDISE\_OR\_SERVICE\_NOT\_AS\_DESCRIBED [#merchandise_or_service_not_as_described]

The buyer reports that the merchandise or service was not as described.

| Evidence type     | Required evidence                                            |
| ----------------- | ------------------------------------------------------------ |
| `OTHER`           | Pass the notes or documents in the `evidences.notes` or `evidences.documents` parameters respectively. For example, you can include a product description, item URL, return policy, or a copy of a contract or an affidavit. |
| `PROOF_OF_REFUND` | Pass the refund ID in the `evidences.evidence_info.refund_ids` parameter. |

### UNAUTHORISED [#unauthorised]

The buyer did not authorize purchase of the merchandise or service.

| Evidence type          | Required evidence                                            |
| ---------------------- | ------------------------------------------------------------ |
| `PROOF_OF_FULFILLMENT` | Provide the carrier name and tracking number through `evidences.evidence_info.tracking_info.carrier_name` and `evidences.evidence_info.tracking_info.tracking_number` parameters respectively. |
| `PROOF_OF_REFUND`      | Pass the refund ID in the `evidences.evidence_info.refund_ids` parameter. |
| `OTHER`                | Pass the notes or documents in the `evidences.notes` or `evidences.documents` parameters respectively. For example, a document can be a proof of delivery signature or a proof of receipt copy. |

### CREDIT\_NOT\_PROCESSED [#credit_not_processed]

The refund or credit transaction was not processed for the buyer.

| Evidence type     | Required evidence                                            |
| ----------------- | ------------------------------------------------------------ |
| `PROOF_OF_REFUND` | Pass the refund ID in the `evidences.evidence_info.refund_ids` parameter. |
| `OTHER`           | Pass the notes or documents in the `evidences.notes` or `evidences.documents` parameters respectively. For example, a document can be a credit due reason. |

### DUPLICATE\_TRANSACTION [#duplicate_transaction]

The transaction was a duplicate.

| Evidence type     | Required evidence                                            |
| ----------------- | ------------------------------------------------------------ |
| `PROOF_OF_REFUND` | Pass the refund ID in the `evidences.evidence_info.refund_ids` parameter. |
| `OTHER`           | Pass the notes or documents in the `evidences.notes` or `evidences.documents` parameters respectively. |

### INCORRECT\_AMOUNT [#incorrect_amount]

The buyer was charged an incorrect amount.

| Evidence type     | Required evidence                                            |
| ----------------- | ------------------------------------------------------------ |
| `PROOF_OF_REFUND` | Pass the refund ID in the `evidences.evidence_info.refund_ids` parameter for the difference in amount. |
| `OTHER`           | Pass the notes or documents in the `evidences.notes` or `evidences.documents` parameters respectively. For example, a document can be a price difference reason. |

### PAYMENT\_BY\_OTHER\_MEANS [#payment_by_other_means]

The buyer paid for the transaction through other means.

| Evidence type     | Required evidence                                            |
| ----------------- | ------------------------------------------------------------ |
| `PROOF_OF_REFUND` | Pass the refund ID in the `evidences.evidence_info.refund_ids` parameter for the difference in amount. |
| `OTHER`           | Pass the notes or documents in the `evidences.notes` or `evidences.documents` parameters respectively. |

### CANCELED\_RECURRING\_BILLING [#canceled_recurring_billing]

The buyer was incorrectly charged after canceling the subscription or recurring billing.

| Evidence type     | Required evidence                                            |
| ----------------- | ------------------------------------------------------------ |
| `PROOF_OF_REFUND` | Pass the refund ID in the `evidences.evidence_info.refund_ids` parameter for the difference in amount. |
| `OTHER`           | Pass the notes or documents in the `evidences.notes` or `evidences.documents` parameters respectively. For example, a document can be a subscription agreement. |

### OTHER [#other]

| Evidence type     | Required evidence                                            |
| ----------------- | ------------------------------------------------------------ |
| `PROOF_OF_REFUND` | Pass the refund ID in the `evidences.evidence_info.refund_ids` parameter. |
| `OTHER`           | Pass the notes or documents in the `evidences.notes` or `evidences.documents` parameters respectively. |