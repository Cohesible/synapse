import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { test, expectEqual } from 'synapse:test'

function ChildComponent(props: { foo: string }) {
    return <div>{props.foo}</div>
}

function MainComponent() {
    return <div>
        <ChildComponent foo='bar'></ChildComponent>
    </div>
}

test('render a component', () => {
    expectEqual(renderToString(MainComponent()), '<div><div>bar</div></div>')
})