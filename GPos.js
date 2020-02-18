const http = require('HttpModule.js')
const ServiceLayerContext = require('ServiceLayerContext.js')
// bring custom tables and objects into scope
require('EntityType/GPOSSALESPOINT.js')
require('EntityType/LB_CDC_DOS.js')

// Valores para U_GPOS_Type
const ORDER_TYPE_QUICKSALE = 101
const ORDER_TYPE_TABLE_OPENED = 102
const ORDER_TYPE_TABLE_CLOSED = 103
const INVOICE_TYPE_FISCAL_INVOICE = 201
const INVOICE_TYPE_NON_FISCAL_INVOICE = 202
const INVOICE_TYPE_AFILIATE_INVOICE = 203
const DELIVERY_TYPE_ROOM_CHARGE = 301

// Grupo de pago effectivo
const PAYGROUP_NONE = -1
// Porcentaje de IT
const TRANSACTIONAL_TAX_PERCENT = 3
// Valores para U_TIPODOC
const DOCTYPE_SALES = 7
const DOCTYPE_NONE = 10

function verifyCompany (session, expectedCompany) {
    const company = session.getProperty('company')
    if (company !== expectedCompany) {
        throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Expected company '${expectedCompany}', got '${company}'`)
    }
    return true
}
function handleRequest (handler) {
    verifyCompany(session, 'BD_GUEMBE_POS')
    
    const ctx = new ServiceLayerContext()

    try {
        handler(ctx)
    } catch (error) {
        // on error, if a transaction is in progress, rollback, then pass on the error to the client
        if (ctx.isInTransaction()) {
            ctx.rollbackTransaction()
        }
        throw error
    }
}
function formatDate(date) {
    return date.getFullYear() + `00${date.getMonth() + 1}`.slice(-2) + `00${date.getDate()}`.slice(-2)
}
function normalizeDate (dateStr) {
    if (!dateStr) return null
    return `${dateStr.slice(0, 4)}${dateStr.slice(5, 7)}${dateStr.slice(8, 10)}`
}
function unwrapOperation (response, errPrefix = '') {
    if (!response.isOK()) {
        const errMsg = response.body.error.message.value
        throw new http.ScriptException(response.status, errPrefix ? `${errPrefix}: ${errMsg}` : errMsg)
    }
    return response.body
}
function getBusinessPartner (ctx, CardCode) {
    return unwrapOperation(ctx.get('BusinessPartners', CardCode), 'Cliente')
}
function getItemsInfo (ctx, Items) {
    return Items.reduce((ItemsInfo, Item) => {
        if (!ItemsInfo[Item.ItemCode]) {
            const ItemInfo = unwrapOperation(ctx.get('Items', Item.ItemCode))

            ItemsInfo[Item.ItemCode] = {
                ItemCode: Item.ItemCode,
                ItemName: ItemInfo.ItemName,
                VatLiable: ItemInfo.VatLiable === 'tYES',
                AllowAffiliate: ItemInfo.U_GPOS_AllowAffiliate === 1,
                AllowCredit: ItemInfo.U_GPOS_AllowCredit === 1,
                TaxGroup: ItemInfo.U_GPOS_TaxGroup
            }
        }
        return ItemsInfo
    }, {})
}
function getAdditionalExpenses (PriceAfterVAT, Quantity) {
    // Calculate Transactional Tax as 3% of line total
    const LineTotal = Math.round(((PriceAfterVAT * 100) * Quantity) * TRANSACTIONAL_TAX_PERCENT) / 10000
    return [
        {
            ExpenseCode: 2, // IT DEBE
            LineTotal: 0 - LineTotal
        },
        {
            ExpenseCode: 4, // IT HABER
            LineTotal: LineTotal
        }
    ]
}
function getSalesPointAuthorization (SalesPoint, TaxGroup, VatLiable) {
    let Authorization
    if (!VatLiable) {
        Authorization = SalesPoint.GPOS_TAXGROUPCollection.find(Authorization => Authorization.U_TaxGroup === TaxGroup && Authorization.U_VATExempt === 1)
    }
    
    if (!Authorization) {
        Authorization = SalesPoint.GPOS_TAXGROUPCollection.find(Authorization => Authorization.U_TaxGroup === TaxGroup && Authorization.U_VATExempt === 0)
    }

    if (!Authorization) {
        throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Punto de venta '${SalesPoint.Code}' no tiene dosificacion para rubro '${TaxGroup}'`)
    }
    
    return Authorization
}
function getOperationAuthorizations (ctx, Items, OperationContext) {
    const { ItemsInfo, SalesPoint, BusinessPartner, Today } = OperationContext

    if (BusinessPartner.Affiliate) return {}

    return Items.reduce((Authorizations, Item) => {
        const TaxGroup = ItemsInfo[Item.ItemCode].TaxGroup
        if (TaxGroup !== 0) {
            const SalesPointAuthorization = getSalesPointAuthorization(SalesPoint, TaxGroup, BusinessPartner.VatLiable)

            const Authorization = unwrapOperation(ctx.get('U_LB_CDC_DOS', SalesPointAuthorization.U_DosCode), 'Dosificacion')

            Authorization.VatLiable = SalesPointAuthorization.U_VATExempt === 0
            Authorization.U_NROINIFACTURA = Number(Authorization.U_NROINIFACTURA)
            Authorization.U_NROFINFACTURA = Number(Authorization.U_NROFINFACTURA)

            if (normalizeDate(Authorization.U_FECHAINIVIGENCIA) > Today) {
                throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Dosificacion ${Authorization.U_NROORDEN}(${Authorization.Code}) aun no entra en vigencia`)
            }
        
            if (normalizeDate(Authorization.U_FECHAFINVIGENCIA) < Today) {
                throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Dosificacion ${Authorization.U_NROORDEN}(${Authorization.Code}) ya no es vigente`)
            }
        
            if (Authorization.U_NROINIFACTURA >= Authorization.U_NROFINFACTURA) {
                throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Dosificacion ${Authorization.U_NROORDEN}(${Authorization.Code}) numero siguiente invalido`)
            }

            Authorizations[String(TaxGroup)] = Authorization
        }
        
        return Authorizations
    }, {})
}
function getOperationSalesPoint (ctx, OperationContext) {
    const SalesPoint = unwrapOperation(ctx.get('GPosSalesPoint', OperationContext.SalesPointCode), 'Punto de venta')

    if (normalizeDate(SalesPoint.U_CurrentDate) !== OperationContext.Today) {
        SalesPoint.U_CurrentDate = OperationContext.Today
        SalesPoint.U_NextOrder = 1
        SalesPoint.U_NextInvoice = 1
    }

    return SalesPoint
}
function getOperationContext (ctx, Data, Test, Operation) {

    const BusinessPartner = getBusinessPartner(ctx, Data.CardCode)
    const VatLiable = BusinessPartner.VatLiable === 'vLiable'
    const Affiliate = BusinessPartner.Affiliate === 'tYES'

    return {
        Test,
        Data,
        Operation,
        Today: formatDate(new Date()),
        ItemsInfo: getItemsInfo(ctx, Data.Items),
        SalesPointCode: Data.SalesPointCode,
        SalesPoint: null, // these to be set later, in transaction
        Authorizations: null, // these to be set later, in transaction
        SalesPersonCode: Data.SalesPersonCode,
        BusinessPartner: {
            CardCode: Data.CardCode,
            CardName: BusinessPartner.CardName,
            Affiliate: Affiliate,
            VatLiable: VatLiable && !Affiliate,
            PayTermsGrpCode: BusinessPartner.PayTermsGrpCode
        }
    }
}
function updateOperationSalesPoint (ctx, OperationContext) {
    const update = {
        U_CurrentDate: OperationContext.SalesPoint.U_CurrentDate,
        U_NextOrder: OperationContext.SalesPoint.U_NextOrder,
        U_NextInvoice: OperationContext.SalesPoint.U_NextInvoice
    }

    return unwrapOperation(ctx.update('GPosSalesPoint', update, OperationContext.SalesPointCode))
}
function updateOperationAuthorizations (ctx, OperationContext) {
    return Object.keys(OperationContext.Authorizations).map(TaxGroup => {
        const Authorization = OperationContext.Authorizations[TaxGroup]

        const update = {
            U_NROINIFACTURA: Authorization.U_NROINIFACTURA
        }

        return unwrapOperation(ctx.update('U_LB_CDC_DOS', update, Authorization.Code))
    })
}
function getSaleItemsFromOrder (Order) {
    return Order.DocumentLines.map(Item => Object.assign(Item, {
        BaseRef: Order.DocNum,
        BaseEntry: Order.DocEntry,
        BaseType: 17, // BaseType 17 = Order
        BaseLine: Item.LineNum
    }))
}
function getSalesPointItem (ItemInfo, SalesPoint) {
    const SalesPointItem = SalesPoint.GPOS_SALESITEMCollection.find(SalesPointItem => SalesPointItem.U_ItemCode === ItemInfo.ItemCode)

    if (!SalesPointItem) {
        throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Articulo '${ItemInfo.ItemName}' (${ItemInfo.ItemCode}) no encontrado para Punto de Venta '${SalesPoint.Name}' (${SalesPoint.Code})`)
    }

    return SalesPointItem
}
function getPrintOrders(Items, Order, OperationContext) {
    const { SalesPoint, ItemsInfo } = OperationContext
    const Printers = Items.reduce((Printers, Item) => {
        const ItemInfo = ItemsInfo[Item.ItemCode]
        const SalesPointItem = getSalesPointItem(ItemInfo, SalesPoint)

        const Printer = SalesPointItem.U_Printer

        if (!Printer) return Printers

        if (!Printers[Printer]) {
            Printers[Printer] = {
                Printer,
                DocDate: Order.DocDate,
                SalesPersonCode: Order.SalesPersonCode,
                U_GPOS_Serial: Order.U_GPOS_Serial,
                U_GPOS_SalesPointCode: Order.U_GPOS_SalesPointCode,
                Items: []
            }
        }

        Printers[SalesPointItem.U_Printer].Items.push({
            ItemCode: Item.ItemCode,
            ItemName: ItemInfo.ItemName,
            Quantity: Item.Quantity
        })

        return Printers
    }, {})
    return Object.keys(Printers).map(Printer => Printers[Printer])
}
function getPrintInvoices(Invoices, Payment, OperationContext) {
    const { Authorizations } = OperationContext
    return Invoices.map(Invoice => {
        let Authorization = null
        if (Invoice.U_GPOS_Type === INVOICE_TYPE_FISCAL_INVOICE) {
            Authorization = Object.keys(Authorizations).reduce((Authorization, TaxGroup) => Authorizations[TaxGroup].Code === Invoice.U_GPOS_DosCode ? Authorizations[TaxGroup] : Authorization, null)
            if (!Authorization) {
                throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Could not find Tax Authorization with Code '${Invoice.U_GPOS_DosCode}' for printing purposes. Should not happen`)
            }
        }
        return Object.assign({
            DocDate: Invoice.DocDate,
            DocTime: Invoice.DocTime,
            DocTotal: Invoice.DocTotal,
            PaymentGroupCode: Invoice.PaymentGroupCode,
            U_GPOS_Type: Invoice.U_GPOS_Type,
            U_GPOS_Serial: Invoice.U_GPOS_Serial,
            U_GPOS_SalesPointCode: Invoice.U_GPOS_SalesPointCode,
            Items: Invoice.DocumentLines.map(Item => {
                return {
                    ItemCode: Item.ItemCode,
                    ItemName: Item.ItemDescription,
                    Quantity: Item.Quantity,
                    PriceAfterVAT: Item.PriceAfterVAT
                }
            }),
        }, Authorization ? {
            // BusinessNIT: '122103025',
            U_FECHALIM: Invoice.U_FECHALIM,
            U_EXENTO: Invoice.U_EXENTO,
            U_ACTIVIDAD: Authorization.U_ACTIVIDAD,
            U_LEYENDA: Authorization.U_LEYENDA,
            U_DIRECCION: Authorization.U_DIRECCION,
            U_CIUDAD: Authorization.U_CIUDAD,
            U_PAIS: Authorization.U_PAIS,
            U_SUCURSAL: Authorization.U_SUCURSAL,
            U_NRO_FAC: Invoice.U_NRO_FAC,
            U_NROAUTOR: Invoice.U_NROAUTOR,
            U_CODCTRL: Invoice.U_CODCTRL,
            U_NIT: Invoice.U_NIT,
            U_RAZSOC: Invoice.U_RAZSOC
        } : {})
    })
}
function createOrder(ctx, Items, OperationContext) {
    // this function has side effects. Specifically OperationContext.SalesPoint will be mutated
    const { SalesPoint, ItemsInfo, BusinessPartner, SalesPersonCode, SalesPointCode, Today } = OperationContext 
    const DocumentLines = Items.map(Item => {
        const ItemInfo = ItemsInfo[Item.ItemCode]
        const SalesPointItem = getSalesPointItem(ItemInfo, SalesPoint)

        // item must either be tax exempt OR have a TaxGroup
        if (ItemInfo.VatLiable && ItemInfo.TaxGroup === 0) {
            throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Articulo '${ItemInfo.ItemName}' (${ItemInfo.ItemCode}) sujeto a impuesto debe tener rubro`)
        }
        if (!ItemInfo.VatLiable && ItemInfo.TaxGroup !== 0) {
            throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Articulo '${ItemInfo.ItemName}' (${ItemInfo.ItemCode}) exento de impuesto no debe tener rubro`)
        }
        
        // if internal client, check if allowed
        if (BusinessPartner.Affiliate && !ItemInfo.AllowAffiliate) {
            throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Articulo '${ItemInfo.ItemName}' (${ItemInfo.ItemCode}) no permitido para consumo de affiliados`)
        }

        // Item VAT Liable if
        // Item itself not exempt and
        // Business Partner not exempt or no VAT Exempt Authorization exists for this sales point 
        const ItemVatLiable = ItemInfo.VatLiable && !BusinessPartner.Affiliate && (BusinessPartner.VatLiable || !SalesPoint.GPOS_TAXGROUPCollection.some(Authorization => Authorization.U_TaxGroup === ItemInfo.TaxGroup && Authorization.U_VATExempt === 1))
        
        return {
            ItemCode: Item.ItemCode,
            Quantity: Item.Quantity,
            PriceAfterVAT: Item.PriceAfterVAT,
            CostingCode: SalesPointItem.U_CostingCode,
            CostingCode2: SalesPointItem.U_CostingCode2,
            WarehouseCode: SalesPointItem.U_WarehouseCode,
            SalesPersonCode: SalesPersonCode,
            TaxCode: ItemVatLiable ? 'IVA' : 'IVA_EXE',
            TaxLiable: ItemVatLiable ? 'tYES' : 'tNO'
        }
    })

    const OrderInput = {
        DocDate: Today,
        DocDueDate: Today,
        CardCode: BusinessPartner.CardCode,
        SalesPersonCode,
        U_GPOS_Type: ORDER_TYPE_QUICKSALE, // TODO: change this depending on operation type
        U_GPOS_SalesPointCode: SalesPointCode,
        U_GPOS_Serial: SalesPoint.U_NextOrder, // use the current number
        DocumentLines
    }

    //  Side effect happens here
    SalesPoint.U_NextOrder += 1

    return {
        Order: unwrapOperation(ctx.add('Orders', OrderInput))
    }
}
function createSale (ctx, Invoice, Items, OperationContext) {
    // this function has side effects. Specifically OperationContext.SalesPoint and OperationContext.Authorizations will be mutated
    const { ItemsInfo, BusinessPartner, SalesPointCode, SalesPoint, SalesPersonCode, Today, Authorizations } = OperationContext

    const Credit = Invoice.PaymentGroupCode !== PAYGROUP_NONE

    if (BusinessPartner.Affiliate && !Credit) {
        throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Cliente Afiliado '${BusinessPartner.CardName}' (${BusinessPartner.CardCode}) solo tiene permitida venta a credito`)
    }
    
    if (Credit && Invoice.PaymentGroupCode !== BusinessPartner.PayTermsGrpCode) {
        throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Cliente '${BusinessPartner.CardName}' (${BusinessPartner.CardCode}) no tiene permitida venta con condicion de pago a credito '${Invoice.PaymentGroupCode}'`)
    }
    
    if (Credit && Invoice.Payment) {
        throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Venta a credito no puede presentar pago`)
    }
    
    if (!Credit && !Invoice.Payment) {
        throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Venta al contado requiere pago`)
    }
    
    // verify pay amounts match
    if (Invoice.Payment) {
        const TotalPaidInCents = Invoice.Payment.PaymentCreditCards.reduce((total, Payment) => total + (Payment.CreditSum * 100), Invoice.Payment.CashSum * 100)
        const TotalPaid = TotalPaidInCents ? TotalPaidInCents / 100 : 0
        
        const TotalToPayInCents = Items.reduce((total, Item) => total + ((Item.PriceAfterVAT * 100) * Item.Quantity), 0)
        const TotalToPay = TotalToPayInCents ? TotalToPayInCents / 100 : 0
        
        if (TotalToPay !== TotalPaid) {
            throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Error de montos de pago. Se esperaba ${TotalToPay}, pero se recibio ${TotalPaid}`)
        }
    }

    const InvoiceBaseInfo = {
        DocDate: Today,
        DocDueDate: Today,
        U_GPOS_SalesPointCode: SalesPointCode,
        SalesPersonCode,
        CardCode: BusinessPartner.CardCode,
        PaymentGroupCode: Invoice.PaymentGroupCode,
        U_NIT: Invoice.U_NIT,
        U_RAZSOC: Invoice.U_RAZSOC        
    }

    const InvoiceInputs = Items.reduce((Invoices, Item) => {
        const ItemInfo = ItemsInfo[Item.ItemCode]
        const ItemTaxGroup = BusinessPartner.Affiliate ? '0' : String(ItemInfo.TaxGroup)
        
        let InvoiceType = null
        if (BusinessPartner.Affiliate) {
            InvoiceType = INVOICE_TYPE_AFILIATE_INVOICE
        } else if (ItemTaxGroup === '0') {
            InvoiceType = INVOICE_TYPE_NON_FISCAL_INVOICE
        } else {
            InvoiceType = INVOICE_TYPE_FISCAL_INVOICE
        }

        // grab current invoice number here.
        // All invoices from a single sale will share the same invoice number
        // side effect happens bello to move counter up
        if (!Invoices[ItemTaxGroup]) {
            Invoices[ItemTaxGroup] = Object.assign({
                DocumentLines: [],
                U_GPOS_Type: InvoiceType,
                U_GPOS_Serial: SalesPoint.U_NextInvoice
            }, InvoiceBaseInfo)
        }

        const AuthorizationVatLiable = ItemTaxGroup !== '0' && Authorizations[ItemTaxGroup].VatLiable
        const ItemVatLiable = ItemsInfo[Item.ItemCode].VatLiable

        // if internal client, check if allowed
        if (BusinessPartner.Affiliate && !ItemInfo.AllowAffiliate) {
            throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Articulo '${ItemInfo.ItemName}' (${ItemInfo.ItemCode}) no permitido para consumo de affiliados`)
        }
        
        if (Credit && !ItemInfo.AllowCredit) {
            throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Articulo '${ItemInfo.ItemName}' (${ItemInfo.ItemCode}) no permitido para consumo a credito`)
        }

        Invoices[ItemTaxGroup].DocumentLines.push({
            ItemCode: Item.ItemCode,
            Quantity: Item.Quantity,
            PriceAfterVAT: Item.PriceAfterVAT,
            CostingCode: Item.CostingCode,
            CostingCode2: Item.CostingCode2,
            WarehouseCode: Item.U_WarehouseCode,
            SalesPersonCode: SalesPersonCode,
            BaseRef: Item.DocNum,
            BaseEntry: Item.DocEntry,
            BaseType: Item.BaseType,
            BaseLine: Item.LineNum,
            TaxCode: ItemVatLiable && AuthorizationVatLiable ? 'IVA' : 'IVA_EXE',
            TaxLiable: ItemVatLiable && AuthorizationVatLiable ? 'tYES' : 'tNO',
            DocumentLineAdditionalExpenses: ItemVatLiable && !BusinessPartner.Affiliate ? getAdditionalExpenses (Item.PriceAfterVAT, Item.Quantity) : []
        })
        
        return Invoices
    }, {})

    const Invoices = Object.keys(InvoiceInputs).map(TaxGroup => {
        const AdditionalInvoiceInformation = {}
        const InvoiceInput = InvoiceInputs[TaxGroup]
        
        if (TaxGroup !== '0') {
            const Authorization = Authorizations[TaxGroup]   
            const InvoiceNumber = Authorization.U_NROINIFACTURA
            // side effect happening here
            Authorization.U_NROINIFACTURA += 1
            
            const InvoiceTotal = InvoiceInput.DocumentLines.reduce((Total, Item) => {
                return Total + ((Item.PriceAfterVAT * 100) * Item.Quantity)
            }, 0) / 100
            
            if (!Authorization.VatLiable) {
                AdditionalInvoiceInformation.U_EXENTO = InvoiceTotal
            }
            
            AdditionalInvoiceInformation.NumAtCard = InvoiceNumber,
            AdditionalInvoiceInformation.U_NROAUTOR = Authorization.U_NROORDEN,
            AdditionalInvoiceInformation.U_FECHALIM = normalizeDate(Authorization.U_FECHAFINVIGENCIA),
            AdditionalInvoiceInformation.U_GPOS_DosCode = Authorization.Code,
            AdditionalInvoiceInformation.U_NRO_FAC = InvoiceNumber,
            AdditionalInvoiceInformation.U_CODCTRL = generateCode(Authorization.U_NROORDEN, String(InvoiceNumber), InvoiceInput.U_NIT, InvoiceInput.DocDate, InvoiceTotal, Authorization.U_LLAVE)
            AdditionalInvoiceInformation.U_TIPODOC = DOCTYPE_SALES
        } else {
            AdditionalInvoiceInformation.U_TIPODOC = DOCTYPE_NONE
        }

        return unwrapOperation(ctx.Invoices.add(Object.assign(InvoiceInput, AdditionalInvoiceInformation)))
    })

    // add 1 to Current invoice number.
    // All invoices from single sale share the same number
    // side effect happening here
    SalesPoint.U_NextInvoice += 1

    const Payment = Invoice.Payment ? unwrapOperation(ctx.add('IncomingPayments', {
        DocDate: Today,
        CardCode: BusinessPartner.CardCode,
        CashAccount: SalesPoint.U_CashAccount,
        CashSum: Invoice.Payment.CashSum,
        PaymentCreditCards: Invoice.Payment.PaymentCreditCards ? Invoice.Payment.PaymentCreditCards : [],
        PaymentInvoices: Invoices.map(Invoice => ({
            DocEntry: Invoice.DocEntry,
            SumApplied: Invoice.DocTotal
        }))
    })) : null

    return {
        Invoices,
        Payment
    }    
}
function OPERATION_QUICKSALE (ctx, Data, Test, Operation) {    
    const OperationContext = getOperationContext(ctx, Data, Test, Operation)
    
    ctx.startTransaction()

    OperationContext.SalesPoint = getOperationSalesPoint(ctx, OperationContext)

    // this function has side effects
    const { Order } = createOrder(ctx, OperationContext.Data.Items, OperationContext)
    
    OperationContext.Authorizations = getOperationAuthorizations(ctx, Order.DocumentLines, OperationContext)
    
    // this function has side effects
    const { Invoices, Payment } = createSale(ctx, Data.Invoice, getSaleItemsFromOrder(Order), OperationContext)

    updateOperationSalesPoint(ctx, OperationContext)
    updateOperationAuthorizations(ctx, OperationContext)

    const PrintOrders = getPrintOrders(OperationContext.Data.Items, Order, OperationContext)
    const PrintInvoices = getPrintInvoices(Invoices, Payment, OperationContext)

    if (Test) {
        ctx.rollbackTransaction()
    } else {
        ctx.commitTransaction()
    }
    
    http.response.send(http.HttpStatus.HTTP_CREATED, {
        // OperationContext,
        // Order,
        // Invoices,
        // Payment,
        Test,
        Print: {
            Orders: PrintOrders,
            Invoices: PrintInvoices
        }
    })
}
function GET () {
    http.response.send(http.HttpStatus.HTTP_OK, 'Extension GuembePOS is up and running!')
}
function POST () {
    handleRequest(ctx => {
        const requestPayload = http.request.getJsonObj()

        switch (requestPayload.Operation) {
            // case 'QUICKSALE': return OPERATION_QUICKSALE(ctx, requestPayload.Data, requestPayload.Test)
            case 'QUICKSALE': return OPERATION_QUICKSALE(ctx, requestPayload.Data, requestPayload.Test, requestPayload.Operation)
            default: throw new http.ScriptException(http.HttpStatus.HTTP_BAD_REQUEST, `Unknown or unimplemented Operation: ${requestPayload.Operation}`)
        }
    })
}

function implode(glue, pieces) {
    //  discuss at: http://phpjs.org/functions/implode/
    // original by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
    // improved by: Waldo Malqui Silva
    // improved by: Itsacon (http://www.itsacon.net/)
    // bugfixed by: Brett Zamir (http://brett-zamir.me)
    //   example 1: implode(' ', ['Kevin', 'van', 'Zonneveld']);
    //   returns 1: 'Kevin van Zonneveld'
    //   example 2: implode(' ', {first:'Kevin', last: 'van Zonneveld'});
    //   returns 2: 'Kevin van Zonneveld'
    var i = '',
        retVal = '',
        tGlue = '';

    if (typeof pieces === 'object') {
        if (Object.prototype.toString.call(pieces) === '[object Array]') {
            return pieces.join(glue);
        }
        for (i in pieces) {
            retVal += tGlue + pieces[i];
            tGlue = glue;
        }
        return retVal;
    }
    return pieces;
}

function splitString(string, split_length) {
    //  discuss at: http://phpjs.org/functions/splitString/
    // original by: Martijn Wieringa
    // improved by: Brett Zamir (http://brett-zamir.me)
    // bugfixed by: Onno Marsman
    //  revised by: Theriault
    //  revised by: Rafal Kukawski (http://blog.kukawski.pl/)
    //    input by: Bjorn Roesbeke (http://www.bjornroesbeke.be/)
    //   example 1: splitString('Hello Friend', 3);
    //   returns 1: ['Hel', 'lo ', 'Fri', 'end']
    if (split_length === null) {
        split_length = 1;
    }
    if (string === null || split_length < 1) {
        return false;
    }
    string += '';
    var chunks = [],
        pos = 0,
        len = string.length;
    while (pos < len) {
        chunks.push(string.slice(pos, pos += split_length));
    }
    return chunks;
}

function encrypt(msg, key) {
    //rc4
    //http://pongwar.com/arc4/
    var result = '';
    try {
        result = strToHex(cipher(msg, key));
    } catch (ex) {
        result = 'ERROR: ' + ex;
    }
    return result;
}

function cipher(msg, key) {
    var state = initState(key);
    var x = 0;
    var y = 0;
    var temp = 0;
    var output = '';
    for (var i = 0; i < msg.length; i = i + 1) {
        x = (x + 1) % 256;
        y = (state[x] + y) % 256;
        temp = state[x];
        state[x] = state[y];
        state[y] = temp;
        output = output + String.fromCharCode(msg.charCodeAt(i) ^ state[(state[x] + state[y]) % 256]);
    }
    return output;
}

function initState(key) {
    var state = new Array(255);
    if (key.length > 0) {
        var j = 0;
        var temp = 0;
        for (var i = 0; i <= 255; i = i + 1) {
            state[i] = i;
        }
        for (var i = 0; i <= 255; i = i + 1) {
            j = (j + state[i] + key.charAt(i % key.length).charCodeAt(0)) % 256;
            temp = state[i];
            state[i] = state[j];
            state[j] = temp;
        }
    } else {
        throw ('Blank Key')
    }
    return state;
}

function strToHex(str) {
    var hex = '';
    for (var i = 0; i < str.length; i = i + 1) {
        hex = hex + decToHex(str.charCodeAt(i));
    }
    return hex;
}

function decToHex(dec) {
    var hex = dec.toString(16);
    if (hex.length < 2) {
        hex = '0' + hex;
    } else if (hex.length > 2) {
        throw ('Unsupported Input')
    }
    return hex;
}

function invertArray(array) {
    // converts string or number to an array and inverts it
    var res = [];
    var cad = array.toString();
    for(var i=cad.length-1; i>=0; i--){
        res = res  + [cad.charAt(i)];
    }

    return res;
};

var Verhoeff = {
    //Verhoweff algorithm: http://en.wikipedia.org/wiki/Verhoeff_algorithm

    // multiplication table d
    'd': [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
        [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
        [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
        [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
        [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
        [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
        [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
        [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
        [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
    ],

    // permutation table p
    'p': [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
        [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
        [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
        [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
        [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
        [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
        [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
    ],

    // inverse table inv
    'inv': [0, 4, 3, 2, 1, 5, 6, 7, 8, 9],

    // generates and returns one checksum digit
    'digit': function(array) {

        var c = 0;
        var invertedArray = invertArray(array);

        for (var i = 0; i < invertedArray.length; i++) {
            c = Verhoeff.d[c][Verhoeff.p[((i + 1) % 8)][invertedArray[i]]];
        }

        return Verhoeff.inv[c];
    },

    // validates checksum
    'validate': function(array) {

        var c = 0;
        var invertedArray = invertArray(array);

        for (var i = 0; i < invertedArray.length; i++) {
            c = Verhoeff.d[c][Verhoeff.p[(i % 8)][invertedArray[i]]];
        }

        return (c === 0);
    },

    // generates nroDigits Verhoeff digits and returns the same array with the two digits apended at the end
    'addDigits': function(array, nroDigits) {
        var r = array.toString();

        for (var i = 0; i < parseInt(nroDigits); i++) {
            r = r + Verhoeff.digit(r).toString();
        }
        return r;
    }
}

function getBase64(n) {
    var d = [
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
        'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n',
        'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '+', '/'
    ];

    var c = 1;
    var r = '';
    while (c > 0) {
        c = Math.floor(n / 64);
        r = d[n % 64] + r;
        n = c;
    }
    return r;
}

function generateCode(numautorizacion, numfactura, nitcliente, fecha, monto, clave) {
	//numautorizacion: string
	//numfactura: string
	//nitcliente: string
	//fecha:string date with format YYYYMMDD
	//monto: numeric
	//clave: string

    var decimal = monto - Math.floor(monto);
    if (decimal >= 0.5) {
        monto = Math.floor(monto) + 1;
    } else {
        monto = Math.floor(monto);
    }

    numfactura = Verhoeff.addDigits(numfactura, 2);
    nitcliente = Verhoeff.addDigits(nitcliente, 2);
    fecha = Verhoeff.addDigits(fecha, 2);
    monto = Verhoeff.addDigits(monto, 2);

    var suma = parseInt(numfactura) + parseInt(nitcliente) + parseInt(fecha) + parseInt(monto);
    suma = Verhoeff.addDigits(suma.toString(), 5);

    var lastFiveVerhoeffDigits = suma.substring(suma.length - 5);

/*
    console.log("clave:", clave);
    console.log("numfactura:", numfactura);
    console.log("nit:", nitcliente);
    console.log("fecha:", fecha);
    console.log("monto:", monto);
    console.log("suma:", suma);
    console.log("Last 5:", lastFiveVerhoeffDigits);
*/

    var cads = [numautorizacion, numfactura, nitcliente, fecha, monto];
    var msg = '';
    var p = 0;
    for (var i = 0; i < 5; i++) {
        var x = 1 + parseInt(lastFiveVerhoeffDigits.charAt(i));
        msg = msg + cads[i] + clave.substr(p, x);
        p = p + x;
    }
    var codif = encrypt(msg, clave + lastFiveVerhoeffDigits);
    codif = codif.toUpperCase();
    var st = 0;
    var sp = [0, 0, 0, 0, 0];
    var codif_length = codif.length;
    for (var i = 0; i < codif_length; i++) {
        st = st + codif.charCodeAt(i);
        sp[i % 5] = sp[i % 5] + codif.charCodeAt(i);
    }
    var stt = 0;
    for (var i = 0; i < 5; i++) {
        stt += Math.floor((st * sp[i]) / (1 + parseInt(lastFiveVerhoeffDigits.charAt(i))));
    }
    //console.log("Sumatoria producto: " + stt); 

    var base64 = getBase64(stt.toString());
    //console.log("Base64: ", base64); 

    var result = implode('-', splitString(encrypt(base64, clave + lastFiveVerhoeffDigits).toUpperCase(), 2));

    return result;
}

function testCodigoControl(numautorizacion, numfactura, nitcliente, fecha, monto, clave, codigoControl) {
    var value = generateCode(numautorizacion, numfactura, nitcliente, fecha, monto, clave);

    if (value != codigoControl)
        return "FAIL";
    else
    	return "OK";
}

//testCodigoControl('29040011007', '1503', '4189179011', '20070702', '2500', '9rCB7Sv4X29d)5k7N%3ab89p-3(5[A', '6A-DC-53-05-14');// OK - PDF CodigocontrolV7 Ejemplo base